import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DriveClient } from '../../../src/core/download/drive'
import type { TokenProvider } from '../../../src/core/download/drive'
import { runDownload } from '../../../src/core/download/downloader'
import type { DownloadEvent, DownloadSummary, EntryResult } from '../../../src/core/download/downloader'
import { appendRecord, journalPath, loadJournal } from '../../../src/core/download/journal'
import { scanFolder } from '../../../src/core/download/scan'
import type { DownloadPlan, PlanEntry } from '../../../src/core/download/types'
import { partialPath } from '../../../src/core/download/writer'
import { FakeDrive } from '../../helpers/fake-drive'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const LATER = '2026-03-01T10:00:00.000Z'

let drive: FakeDrive
let client: DriveClient
let tmp: string
let chosenDir: string

beforeEach(async () => {
  drive = await FakeDrive.start()
  const tokens: TokenProvider = {
    getAccessToken: () => Promise.resolve('test-token'),
    refresh: () => Promise.resolve('test-token'),
  }
  client = new DriveClient({ tokens, baseUrl: drive.baseUrl, sleep: () => Promise.resolve(), maxRetries: 0 })
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'downloader-test-'))
  chosenDir = path.join(tmp, 'Disk')
  await fs.mkdir(chosenDir)
})

afterEach(async () => {
  await drive.close()
  await fs.rm(tmp, { recursive: true, force: true })
})

const md5 = (b: Buffer | string): string => createHash('md5').update(b).digest('hex')
const abs = (rel: string): string => path.join(chosenDir, rel)
const read = (rel: string): Promise<string> => fs.readFile(abs(rel), 'utf8')

type RunOpts = Partial<Parameters<typeof runDownload>[0]>

function run(plan: DownloadPlan, extra: RunOpts = {}): Promise<DownloadSummary> {
  return runDownload({ client, plan, chosenDir, ...extra })
}

/** Requests that transfer file bytes (downloads and exports). */
const transfers = (): typeof drive.requests =>
  drive.requests.filter((r) => r.query['alt'] === 'media' || r.path.endsWith('/export'))

const byPath = (summary: DownloadSummary): Map<string, EntryResult> =>
  new Map(summary.results.map((r) => [r.entry.localRelPath, r]))

const result = (summary: DownloadSummary, plannedPath: string): EntryResult => {
  const found = byPath(summary).get(plannedPath)
  if (!found) throw new Error(`no result for ${plannedPath}`)
  return found
}

const entryOf = (plan: DownloadPlan, rel: string): PlanEntry => {
  const found = plan.entries.find((e) => e.localRelPath === rel)
  if (!found) throw new Error(`no plan entry ${rel}`)
  return found
}

/** Every regular file under `dir` (relative paths), symlinks not followed. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? d.name : `${prefix}/${d.name}`
    if (d.isDirectory()) out.push(...(await listFiles(path.join(dir, d.name), rel)))
    else out.push(rel)
  }
  return out.sort()
}

type Node = { kind: 'file' | 'dir' | 'link' | 'other'; size: number; mtimeMs: number; ino: number; hash: string | null }

/** Snapshot of everything under `dir` (lstat, symlinks not followed), with content hashes of files. */
async function snapshot(dir: string, prefix = '', out = new Map<string, Node>()): Promise<Map<string, Node>> {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? d.name : `${prefix}/${d.name}`
    const p = path.join(dir, d.name)
    const st = await fs.lstat(p)
    const kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'other'
    out.set(rel, {
      kind,
      size: kind === 'dir' ? 0 : st.size,
      // A directory's mtime changes when entries are added to it, which is allowed.
      mtimeMs: kind === 'dir' ? 0 : st.mtimeMs,
      ino: st.ino,
      hash: kind === 'file' ? md5(await fs.readFile(p)) : kind === 'link' ? await fs.readlink(p) : null,
    })
    if (kind === 'dir') await snapshot(p, rel, out)
  }
  return out
}

/** Nothing that existed is changed or removed; every new path is the app's own (journal, temps, planned outputs). */
function expectOnlyOwnAdditions(before: Map<string, Node>, after: Map<string, Node>, plan: DownloadPlan, summaries: DownloadSummary[]): void {
  for (const [rel, node] of before) expect(after.get(rel), rel).toEqual(node)
  const outputs = new Set(summaries.flatMap((s) => s.results.map((r) => r.localRelPath)))
  const folders = new Set(plan.folders)
  const root = plan.rootName
  for (const rel of after.keys()) {
    if (before.has(rel)) continue
    const own =
      folders.has(rel) ||
      outputs.has(rel) ||
      rel === `${root}/.stahovani` ||
      rel === `${root}/.stahovani/journal.jsonl` ||
      /(^|\/)\.[^/]+\.(partial|bad(\.\d+)?)$/.test(rel)
    expect(own, `unexpected new path ${rel}`).toBe(true)
  }
}

async function scan(rootId: string): Promise<DownloadPlan> {
  return scanFolder(client, rootId)
}

/** Byte progress never goes down, never exceeds the total, and ends at the total. */
function expectMonotonicProgress(events: DownloadEvent[], totalBytes: number): void {
  const done = events.flatMap((e) => (e.type === 'bytes' ? [e.doneBytes] : []))
  expect(done.length).toBeGreaterThan(0)
  for (let i = 1; i < done.length; i += 1) expect(done[i], `event ${i}`).toBeGreaterThanOrEqual(done[i - 1] ?? 0)
  expect(Math.max(...done)).toBeLessThanOrEqual(totalBytes)
  expect(done.at(-1)).toBe(totalBytes)
}

const journalLines = async (rel: string): Promise<number> =>
  (await fs.readFile(journalPath(abs(rel)), 'utf8')).split('\n').filter((l) => l.trim() !== '').length

describe('runDownload', () => {
  it('downloads the full tree with identical structure and bytes', async () => {
    const root = drive.addFolder('Zápas')
    const big = randomBytes(300 * 1024)
    drive.addTree(root, {
      'a.mp4': big,
      'b.txt': 'hello',
      Druhá: { 'c.mp4': 'ccc', Třetí: { 'd.bin': 'dddd' } },
      Prázdná: {},
    })
    const plan = await scan(root)
    const events: DownloadEvent[] = []
    const before = await snapshot(chosenDir)

    const summary = await run(plan, { onEvent: (e) => events.push(e) })

    expect(summary.status).toBe('complete')
    expect(summary.results.map((r) => r.outcome)).toEqual(['downloaded', 'downloaded', 'downloaded', 'downloaded'])
    expect(summary.downloadedBytes).toBe(plan.totalBytes)
    expect(Date.parse(summary.finishedAt)).toBeGreaterThanOrEqual(Date.parse(summary.startedAt))
    expect(await fs.readFile(abs('Zápas/a.mp4'))).toEqual(big)
    expect(await read('Zápas/b.txt')).toBe('hello')
    expect(await read('Zápas/Druhá/c.mp4')).toBe('ccc')
    expect(await read('Zápas/Druhá/Třetí/d.bin')).toBe('dddd')
    expect((await fs.lstat(abs('Zápas/Prázdná'))).isDirectory()).toBe(true)
    expect(await listFiles(chosenDir)).toEqual([
      'Zápas/.stahovani/journal.jsonl',
      'Zápas/Druhá/Třetí/d.bin',
      'Zápas/Druhá/c.mp4',
      'Zápas/a.mp4',
      'Zápas/b.txt',
    ])
    const a = result(summary, 'Zápas/a.mp4')
    expect(a).toMatchObject({ localRelPath: 'Zápas/a.mp4', md5: md5(big), bytes: big.length, reason: null })

    const journal = await loadJournal(abs('Zápas'))
    expect(journal.get(a.entry.fileId)).toMatchObject({ localRelPath: 'Zápas/a.mp4', size: big.length, md5: md5(big), kind: 'file' })
    expect(journal.size).toBe(4)

    // events: file_start / file_done per entry in plan order; byte progress ends at the total and never exceeds it
    const starts = events.flatMap((e) => (e.type === 'file_start' ? [e.index] : []))
    expect(starts).toEqual([0, 1, 2, 3])
    expect(events.filter((e) => e.type === 'file_done')).toHaveLength(4)
    const bytes = events.flatMap((e) => (e.type === 'bytes' ? [e] : []))
    expect(bytes.length).toBeGreaterThan(0)
    for (const e of bytes) {
      expect(e.totalBytes).toBe(plan.totalBytes)
      expect(e.doneBytes).toBeLessThanOrEqual(plan.totalBytes)
    }
    expect(bytes.at(-1)?.doneBytes).toBe(plan.totalBytes)

    expectOnlyOwnAdditions(before, await snapshot(chosenDir), plan, [summary])
  })

  it('reports everything as already on a second run, with zero download requests', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.mp4': 'aaaa', Sub: { 'b.mp4': 'bb' } })
    const plan = await scan(root)
    expect((await run(plan)).status).toBe('complete')
    drive.clearLog()

    const second = await run(plan)

    expect(second.status).toBe('complete')
    expect(second.results.map((r) => r.outcome)).toEqual(['already', 'already'])
    expect(result(second, 'Root/Sub/b.mp4')).toMatchObject({ localRelPath: 'Root/Sub/b.mp4', bytes: 2, md5: md5('bb') })
    expect(second.downloadedBytes).toBe(0)
    expect(drive.requests).toHaveLength(0)
  })

  it('downloads a file changed on Drive as a new copy and leaves the original untouched', async () => {
    const root = drive.addFolder('Root')
    const id = drive.addFile(root, 'X.mp4', 'old content')
    expect((await run(await scan(root))).status).toBe('complete')
    const originalStat = await fs.stat(abs('Root/X.mp4'))

    drive.updateFile(id, { bytes: 'new content!', modifiedTime: LATER })
    const plan = await scan(root)
    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/X.mp4')).toMatchObject({ outcome: 'changed_copy', localRelPath: 'Root/X (2).mp4', md5: md5('new content!') })
    expect(await read('Root/X (2).mp4')).toBe('new content!')
    expect(await read('Root/X.mp4')).toBe('old content')
    const nowStat = await fs.stat(abs('Root/X.mp4'))
    expect(nowStat.mtimeMs).toBe(originalStat.mtimeMs)
    expect(nowStat.ino).toBe(originalStat.ino)

    drive.clearLog()
    const third = await run(plan)
    expect(result(third, 'Root/X.mp4')).toMatchObject({ outcome: 'already', localRelPath: 'Root/X (2).mp4' })
    expect(transfers()).toHaveLength(0)
  })

  it('stops when the destination disappears', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { '1.mp4': 'one', '2.mp4': 'two', '3.mp4': 'three', '4.mp4': 'four' })
    const plan = await scan(root)
    const moved = path.join(tmp, 'Unplugged')
    let done = 0
    const started: number[] = []

    const summary = await run(plan, {
      onEvent: (e) => {
        if (e.type === 'file_start') started.push(e.index)
        if (e.type === 'file_done' && ++done === 2) renameSync(chosenDir, moved)
      },
    })

    expect(summary.status).toBe('destination_lost')
    // checked before the next entry starts
    expect(started).toEqual([0, 1])
    expect(summary.results).toHaveLength(2)
    expect(summary.results.every((r) => r.outcome === 'downloaded')).toBe(true)
    // never recreated
    await expect(fs.lstat(chosenDir)).rejects.toMatchObject({ code: 'ENOENT' })
    const finished = (await listFiles(moved)).filter((f) => !f.includes('/.'))
    expect(finished).toEqual(['Root/1.mp4', 'Root/2.mp4'])

    renameSync(moved, chosenDir)
    const again = await run(plan)
    expect(again.status).toBe('complete')
    expect(again.results.map((r) => r.outcome)).toEqual(['already', 'already', 'downloaded', 'downloaded'])
    expect(await read('Root/4.mp4')).toBe('four')
  })

  it('stops with destination_lost when the disk disappears mid-file and reports nothing for that file', async () => {
    const root = drive.addFolder('Root')
    const big = randomBytes(256 * 1024)
    drive.addTree(root, { 'a.txt': 'a', 'big.bin': big, 'c.txt': 'c' })
    const plan = await scan(root)
    const bigId = entryOf(plan, 'Root/big.bin').fileId
    drive.chunkSize = 32 * 1024
    drive.chunkDelayMs = 5
    const moved = path.join(tmp, 'Unplugged')
    let renamed = false

    const summary = await run(plan, {
      onEvent: (e) => {
        if (e.type === 'bytes' && !renamed && e.doneBytes > 1) {
          renamed = true
          renameSync(chosenDir, moved)
        }
      },
    })

    expect(summary.status).toBe('destination_lost')
    expect(summary.results.map((r) => r.entry.localRelPath)).toEqual(['Root/a.txt'])
    await expect(fs.lstat(path.join(moved, 'Root/big.bin'))).rejects.toMatchObject({ code: 'ENOENT' })

    renameSync(moved, chosenDir)
    drive.chunkSize = null
    drive.chunkDelayMs = 0
    drive.clearLog()
    const again = await run(plan)
    expect(again.status).toBe('complete')
    expect(again.results.map((r) => r.outcome)).toEqual(['already', 'downloaded', 'downloaded'])
    expect(await fs.readFile(abs('Root/big.bin'))).toEqual(big)
    await expect(fs.lstat(partialPath(abs('Root'), bigId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops on auth loss without marking the next file failed', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { '1.mp4': 'one', '2.mp4': 'two', '3.mp4': 'three' })
    const plan = await scan(root)

    const summary = await run(plan, {
      onEvent: (e) => {
        if (e.type === 'file_done') drive.rejectAllTokens()
      },
    })

    expect(summary.status).toBe('auth_lost')
    expect(summary.results).toHaveLength(1)
    expect(summary.results[0]?.outcome).toBe('downloaded')
    expect(summary.results.some((r) => r.outcome === 'failed')).toBe(false)
  })

  it('marks a cannot_download file failed, continues, and ends incomplete', async () => {
    const root = drive.addFolder('Root')
    const ids = drive.addTree(root, { '1.mp4': 'one', '2.mp4': 'two', '3.mp4': 'three' })
    drive.scriptFailures(drive.filePath(ids.get('2.mp4') ?? ''), [{ status: 403, reason: 'cannotDownloadFile' }])
    const plan = await scan(root)

    const summary = await run(plan)

    expect(summary.status).toBe('incomplete')
    expect(result(summary, 'Root/2.mp4')).toMatchObject({ outcome: 'failed', reason: 'vlastník zakázal stahování', bytes: 0, md5: null })
    expect(result(summary, 'Root/3.mp4').outcome).toBe('downloaded')
    await expect(fs.lstat(abs('Root/2.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails a file whose owner disabled downloading without any Drive request, and ends incomplete', async () => {
    const root = drive.addFolder('Root')
    drive.addFile(root, '1.mp4', 'one')
    drive.addFile(root, 'locked.mp4', 'secret', { canDownload: false })
    drive.addGoogleDoc(root, 'Doc', { [DOCX_MIME]: 'docx' }, { canDownload: false })
    const plan = await scan(root)
    drive.clearLog()

    const summary = await run(plan)

    expect(summary.status).toBe('incomplete')
    expect(result(summary, 'Root/locked.mp4')).toMatchObject({ outcome: 'failed', reason: 'vlastník zakázal stahování', bytes: 0 })
    expect(result(summary, 'Root/Doc.docx')).toMatchObject({ outcome: 'failed', reason: 'vlastník zakázal stahování', bytes: 0 })
    expect(result(summary, 'Root/1.mp4').outcome).toBe('downloaded')
    expect(transfers().map((r) => r.path)).toEqual([drive.filePath(entryOf(plan, 'Root/1.mp4').fileId)])
    await expect(fs.lstat(abs('Root/locked.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('re-attempts blocked files on a retry: fails again while Drive refuses, downloads once allowed', async () => {
    const root = drive.addFolder('Root')
    const locked = drive.addFile(root, 'locked.mp4', 'secret', { canDownload: false })
    const plan = await scan(root)

    const again = await run(plan, { retryBlocked: true })
    expect(again.status).toBe('incomplete')
    expect(result(again, 'Root/locked.mp4')).toMatchObject({ outcome: 'failed', reason: 'vlastník zakázal stahování' })
    expect(transfers()).toHaveLength(1)

    drive.updateFile(locked, { canDownload: true })
    const allowed = await run(plan, { retryBlocked: true })
    expect(allowed.status).toBe('complete')
    expect(result(allowed, 'Root/locked.mp4').outcome).toBe('downloaded')
    expect(await read('Root/locked.mp4')).toBe('secret')
  })

  it('reports a blocked file that an earlier run already downloaded as already, without a request', async () => {
    const root = drive.addFolder('Root')
    const file = drive.addFile(root, 'a.mp4', 'abc')
    expect((await run(await scan(root))).status).toBe('complete')
    drive.updateFile(file, { canDownload: false })
    const plan = await scan(root)
    drive.clearLog()

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/a.mp4').outcome).toBe('already')
    expect(transfers()).toEqual([])
  })

  it('marks a file failed with a connection message when the server keeps failing', async () => {
    const root = drive.addFolder('Root')
    const ids = drive.addTree(root, { '1.mp4': 'one', '2.mp4': 'two' })
    drive.scriptFailures(drive.filePath(ids.get('1.mp4') ?? ''), [{ status: 503 }])
    const plan = await scan(root)

    const summary = await run(plan)

    expect(summary.status).toBe('incomplete')
    expect(result(summary, 'Root/1.mp4')).toMatchObject({ outcome: 'failed', reason: 'výpadek spojení, zkus znovu' })
    expect(result(summary, 'Root/2.mp4').outcome).toBe('downloaded')
  })

  it('reports a body that keeps breaking off with an errno code as a connection drop, never as a disk error', async () => {
    const root = drive.addFolder('Root')
    drive.addFile(root, 'a.mp4', 'abcdef')
    const plan = await scan(root)
    const reset = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
        },
      })
    const stub = { download: () => Promise.resolve(reset()), exportFile: () => Promise.resolve(reset()) }

    const summary = await run(plan, { client: stub })

    expect(summary.status).toBe('incomplete')
    expect(result(summary, 'Root/a.mp4')).toMatchObject({ outcome: 'failed', reason: 'výpadek spojení, zkus znovu' })
  })

  it('notes that only the size was verified for a downloaded file without a Google MD5', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.mp4': 'abc', 'b.mp4': 'defg' })
    const scanned = await scan(root)
    const plan = { ...scanned, entries: scanned.entries.map((e) => (e.localRelPath === 'Root/a.mp4' ? { ...e, md5: null } : e)) }

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/a.mp4')).toMatchObject({ outcome: 'downloaded', reason: 'ověřena jen velikost (Google neuvádí MD5)' })
    expect(result(summary, 'Root/b.mp4')).toMatchObject({ outcome: 'downloaded', reason: null })
  })

  it.each(['ENOSPC', 'EDQUOT'])('stops the run with disk_full on %s, keeps the partial and attempts no later file', async (code) => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { '1.mp4': 'one', '2.mp4': 'two', '3.mp4': 'three' })
    const plan = await scan(root)
    let links = 0
    const linkFn = async (a: string, b: string): Promise<void> => {
      links += 1
      if (links === 2) throw Object.assign(new Error(`${code}: no space left on device`), { code })
      await fs.link(a, b)
    }

    const summary = await run(plan, { linkFn })

    expect(summary.status).toBe('disk_full')
    expect(summary.results.map((r) => [r.entry.localRelPath, r.outcome])).toEqual([['Root/1.mp4', 'downloaded']])
    expect(await fs.readFile(partialPath(abs('Root'), entryOf(plan, 'Root/2.mp4').fileId), 'utf8')).toBe('two')
    await expect(fs.lstat(abs('Root/2.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(abs('Root/3.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('aborts mid-file, keeps the partial, and the next run resumes with a Range request', async () => {
    const root = drive.addFolder('Root')
    const big = randomBytes(512 * 1024)
    drive.addTree(root, { 'big.bin': big, 'z.txt': 'z' })
    const plan = await scan(root)
    const bigId = entryOf(plan, 'Root/big.bin').fileId
    drive.chunkSize = 64 * 1024
    drive.chunkDelayMs = 10
    const controller = new AbortController()

    const summary = await run(plan, {
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'bytes' && e.doneBytes > 0) controller.abort()
      },
    })

    expect(summary.status).toBe('aborted')
    expect(summary.results).toHaveLength(0)
    const partial = await fs.stat(partialPath(abs('Root'), bigId))
    expect(partial.size).toBeGreaterThan(0)
    expect(partial.size).toBeLessThan(big.length)
    await expect(fs.lstat(abs('Root/big.bin'))).rejects.toMatchObject({ code: 'ENOENT' })

    drive.chunkSize = null
    drive.chunkDelayMs = 0
    drive.clearLog()
    const again = await run(plan)
    expect(again.status).toBe('complete')
    const media = transfers().filter((r) => r.path === drive.filePath(bigId))
    expect(media).toHaveLength(1)
    expect(media[0]?.headers.range).toBe(`bytes=${partial.size}-`)
    expect(await fs.readFile(abs('Root/big.bin'))).toEqual(big)
  })

  it('returns aborted without touching the disk when the signal is already aborted', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.txt': 'a' })
    const plan = await scan(root)
    const controller = new AbortController()
    controller.abort()

    const summary = await run(plan, { signal: controller.signal })

    expect(summary.status).toBe('aborted')
    expect(await fs.readdir(chosenDir)).toEqual([])
  })

  it('keeps exactly one download in flight', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.bin': randomBytes(64 * 1024), 'b.bin': randomBytes(64 * 1024), 'c.bin': randomBytes(64 * 1024) })
    const plan = await scan(root)
    drive.chunkSize = 16 * 1024
    drive.chunkDelayMs = 5
    drive.resetConcurrency()

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(drive.maxConcurrentDownloads).toBe(1)
  })

  it('never modifies a foreign file at the planned path and lands the download as A (2).mp4', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'A.mp4': 'drive bytes', 'B.mp4': 'bbb' })
    const plan = await scan(root)
    await fs.mkdir(abs('Root'))
    await fs.writeFile(abs('Root/A.mp4'), 'my own different file')
    await fs.writeFile(abs('Root/notes.txt'), 'unrelated')
    await fs.writeFile(path.join(tmp, 'outside.txt'), 'outside')
    await fs.symlink(path.join(tmp, 'outside.txt'), abs('Root/link.txt'))
    await fs.mkdir(abs('Other'))
    await fs.writeFile(abs('Other/x.txt'), 'x')
    const before = await snapshot(chosenDir)

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/A.mp4')).toMatchObject({ outcome: 'downloaded', localRelPath: 'Root/A (2).mp4' })
    expect(await read('Root/A (2).mp4')).toBe('drive bytes')
    expect(await read('Root/A.mp4')).toBe('my own different file')
    expect(await fs.readFile(path.join(tmp, 'outside.txt'), 'utf8')).toBe('outside')
    expectOnlyOwnAdditions(before, await snapshot(chosenDir), plan, [summary])

    // the journal remembers the copy: a second run adds nothing
    drive.clearLog()
    const second = await run(plan)
    expect(result(second, 'Root/A.mp4')).toMatchObject({ outcome: 'already', localRelPath: 'Root/A (2).mp4' })
    expect(transfers()).toHaveLength(0)
  })

  it('skips free-name candidates taken on disk (case-insensitively) or by other plan entries', async () => {
    const root = drive.addFolder('Root')
    // the plan itself holds "A.mp4" and "a (2).mp4" (case collision named by the scan)
    drive.addFile(root, 'A.mp4', 'first', { createdTime: '2026-01-01T10:00:00.000Z' })
    drive.addFile(root, 'a.mp4', 'second', { createdTime: '2026-01-01T11:00:00.000Z' })
    const plan = await scan(root)
    expect(plan.entries.map((e) => e.localRelPath)).toEqual(['Root/A.mp4', 'Root/a (2).mp4'])
    await fs.mkdir(abs('Root'))
    await fs.writeFile(abs('Root/A.mp4'), 'foreign')
    await fs.writeFile(abs('Root/A (3).MP4'), 'foreign too')

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/A.mp4').localRelPath).toBe('Root/A (4).mp4')
    expect(result(summary, 'Root/a (2).mp4').localRelPath).toBe('Root/a (2).mp4')
    expect(await read('Root/A (4).mp4')).toBe('first')
    expect(await read('Root/A.mp4')).toBe('foreign')
    expect(await read('Root/A (3).MP4')).toBe('foreign too')
  })

  it('adopts an identical file at the planned path without downloading it (Ruling 10)', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'A.mp4': 'same bytes', 'B.mp4': 'bbb' })
    const plan = await scan(root)
    await fs.mkdir(abs('Root'))
    await fs.writeFile(abs('Root/A.mp4'), 'same bytes')
    const before = await fs.stat(abs('Root/A.mp4'))
    const aId = entryOf(plan, 'Root/A.mp4').fileId

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/A.mp4')).toMatchObject({ outcome: 'already', localRelPath: 'Root/A.mp4', md5: md5('same bytes'), bytes: 10 })
    expect(transfers().filter((r) => r.path === drive.filePath(aId))).toHaveLength(0)
    const after = await fs.stat(abs('Root/A.mp4'))
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
    expect((await loadJournal(abs('Root'))).get(aId)).toMatchObject({ localRelPath: 'Root/A.mp4', size: 10, localMtimeMs: before.mtimeMs })
    expect(await listFiles(abs('Root'))).toEqual(['.stahovani/journal.jsonl', 'A.mp4', 'B.mp4'])
  })

  it('finalises on a volume without hard links', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.mp4': 'aaaa', Sub: { 'b.mp4': 'bb' } })
    const plan = await scan(root)
    let linkCalls = 0
    const linkFn = (): Promise<void> => {
      linkCalls += 1
      return Promise.reject(Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }))
    }

    const summary = await run(plan, { linkFn })

    expect(summary.status).toBe('complete')
    expect(linkCalls).toBe(2)
    expect(await read('Root/a.mp4')).toBe('aaaa')
    expect(await read('Root/Sub/b.mp4')).toBe('bb')
    expect(await listFiles(chosenDir)).toEqual(['Root/.stahovani/journal.jsonl', 'Root/Sub/b.mp4', 'Root/a.mp4'])
  })

  it('exports a Google Doc end to end and finds it on the next run', async () => {
    const root = drive.addFolder('Root')
    const docId = drive.addGoogleDoc(root, 'Poznámky', { [DOCX_MIME]: 'docx bytes' })
    const plan = await scan(root)
    expect(entryOf(plan, 'Root/Poznámky.docx')).toMatchObject({ kind: 'export', exportMime: DOCX_MIME })

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/Poznámky.docx')).toMatchObject({ outcome: 'exported', localRelPath: 'Root/Poznámky.docx', bytes: 10 })
    expect(summary.downloadedBytes).toBe(10)
    expect(await read('Root/Poznámky.docx')).toBe('docx bytes')
    const exp = transfers()
    expect(exp).toHaveLength(1)
    expect(exp[0]).toMatchObject({ path: drive.filePath(docId, 'export'), query: expect.objectContaining({ mimeType: DOCX_MIME }) })

    drive.clearLog()
    const second = await run(plan)
    expect(result(second, 'Root/Poznámky.docx').outcome).toBe('already')
    expect(transfers()).toHaveLength(0)
  })

  it('retries a mismatch once from a fresh partial and keeps the .bad file', async () => {
    const root = drive.addFolder('Root')
    const id = drive.addFile(root, 'v.mp4', 'good bytes')
    const plan = await scan(root)
    drive.updateFile(id, { bytes: 'evil bytes' })
    let calls = 0
    const flaky: Pick<DriveClient, 'download' | 'exportFile'> = {
      download: async (fileId, fromByte, signal) => {
        const stream = await client.download(fileId, fromByte, signal)
        calls += 1
        if (calls === 1) drive.updateFile(id, { bytes: 'good bytes' })
        return stream
      },
      exportFile: (fileId, mime, signal) => client.exportFile(fileId, mime, signal),
    }

    const summary = await run(plan, { client: flaky })

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/v.mp4')).toMatchObject({ outcome: 'downloaded', md5: md5('good bytes') })
    expect(calls).toBe(2)
    expect(await read('Root/v.mp4')).toBe('good bytes')
    expect(await fs.readFile(path.join(abs('Root'), `.${id}.bad`), 'utf8')).toBe('evil bytes')
  })

  it('fails a file that is corrupt twice', async () => {
    const root = drive.addFolder('Root')
    const id = drive.addFile(root, 'v.mp4', 'some bytes', { md5: 'ffffffffffffffffffffffffffffffff' })
    drive.addFile(root, 'w.mp4', 'ok')
    const plan = await scan(root)

    const summary = await run(plan)

    expect(summary.status).toBe('incomplete')
    expect(result(summary, 'Root/v.mp4')).toMatchObject({ outcome: 'failed', reason: 'soubor se stáhl poškozený' })
    expect(transfers().filter((r) => r.path === drive.filePath(id))).toHaveLength(2)
    await expect(fs.lstat(abs('Root/v.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(abs('Root'))).filter((n) => n.includes('.bad')).sort()).toEqual([`.${id}.bad`, `.${id}.bad.2`])
    expect(result(summary, 'Root/w.mp4').outcome).toBe('downloaded')
  })

  it('reports a repeated fileId as already, pointing at the first copy (Ruling 11)', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'A.mp4': 'aaa' })
    const scanned = await scan(root)
    const a = entryOf(scanned, 'Root/A.mp4')
    const plan: DownloadPlan = { ...scanned, entries: [a, { ...a, localRelPath: 'Root/Again.mp4' }] }

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(summary.results.map((r) => [r.outcome, r.localRelPath])).toEqual([
      ['downloaded', 'Root/A.mp4'],
      ['already', 'Root/A.mp4'],
    ])
    expect(transfers()).toHaveLength(1)
    await expect(fs.lstat(abs('Root/Again.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records skip entries as skipped and still completes', async () => {
    const root = drive.addFolder('Root')
    drive.addFile(root, 'odkaz', '', { mimeType: SHORTCUT_MIME })
    drive.addFile(root, 'a.txt', 'a')
    const plan = await scan(root)

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/odkaz')).toMatchObject({ outcome: 'skipped', reason: 'zástupce (nestahuje se)', bytes: 0 })
    await expect(fs.lstat(abs('Root/odkaz'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails the subtree under a symlink or file in place of a folder, never following or removing it', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'top.txt': 't', Sub: { 's.txt': 's' }, Sub2: { Deep: { 'd.txt': 'd' } } })
    const plan = await scan(root)
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    await fs.mkdir(abs('Root'))
    await fs.symlink(outside, abs('Root/Sub'))
    await fs.writeFile(abs('Root/Sub2'), 'a file, not a folder')
    const before = await snapshot(chosenDir)

    const summary = await run(plan)

    expect(summary.status).toBe('incomplete')
    expect(result(summary, 'Root/top.txt').outcome).toBe('downloaded')
    for (const rel of ['Root/Sub/s.txt', 'Root/Sub2/Deep/d.txt']) {
      const r = result(summary, rel)
      expect(r.outcome).toBe('failed')
      expect(r.reason).toMatch(/složk/)
    }
    expect(await fs.readdir(outside)).toEqual([])
    expect((await fs.lstat(abs('Root/Sub'))).isSymbolicLink()).toBe(true)
    expect(await read('Root/Sub2')).toBe('a file, not a folder')
    expectOnlyOwnAdditions(before, await snapshot(chosenDir), plan, [summary])
  })

  it('stops with destination_lost when the chosen directory is missing, without creating it', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.txt': 'a' })
    const plan = await scan(root)
    const missing = path.join(tmp, 'missing')

    const summary = await runDownload({ client, plan, chosenDir: missing })

    expect(summary.status).toBe('destination_lost')
    expect(summary.results).toEqual([])
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(transfers()).toHaveLength(0)
  })

  it('stops with journal_error on a damaged journal and leaves it alone', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.txt': 'a' })
    const plan = await scan(root)
    await fs.mkdir(abs('Root/.stahovani'), { recursive: true })
    const target = path.join(tmp, 'elsewhere.jsonl')
    await fs.writeFile(target, 'not ours')
    await fs.symlink(target, journalPath(abs('Root')))

    const summary = await run(plan)

    expect(summary.status).toBe('journal_error')
    expect(summary.results).toEqual([])
    expect(transfers()).toHaveLength(0)
    expect(await fs.readFile(target, 'utf8')).toBe('not ours')
    expect((await fs.lstat(journalPath(abs('Root')))).isSymbolicLink()).toBe(true)
  })

  it('accepts an existing destination root holding only .DS_Store and an empty .stahovani', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.txt': 'a' })
    const plan = await scan(root)
    await fs.mkdir(abs('Root/.stahovani'), { recursive: true })
    await fs.writeFile(abs('Root/.DS_Store'), 'finder')

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(await read('Root/a.txt')).toBe('a')
    expect(await read('Root/.DS_Store')).toBe('finder')
  })

  it('keeps byte progress monotonic across a mismatch retry', async () => {
    const root = drive.addFolder('Root')
    const good = randomBytes(64 * 1024)
    const id = drive.addFile(root, 'v.bin', good)
    drive.addFile(root, 'w.txt', 'w')
    const plan = await scan(root)
    drive.updateFile(id, { bytes: randomBytes(64 * 1024) })
    drive.chunkSize = 8 * 1024
    let calls = 0
    const flaky: Pick<DriveClient, 'download' | 'exportFile'> = {
      download: async (fileId, fromByte, signal) => {
        const stream = await client.download(fileId, fromByte, signal)
        if (fileId === id && ++calls === 1) drive.updateFile(id, { bytes: good })
        return stream
      },
      exportFile: (fileId, mime, signal) => client.exportFile(fileId, mime, signal),
    }
    const events: DownloadEvent[] = []

    const summary = await run(plan, { client: flaky, onEvent: (e) => events.push(e) })

    expect(summary.status).toBe('complete')
    expect(calls).toBe(2)
    expectMonotonicProgress(events, plan.totalBytes)
  })

  it('keeps byte progress monotonic when the writer restarts a partial from 0', async () => {
    const root = drive.addFolder('Root')
    const big = randomBytes(128 * 1024)
    drive.addTree(root, { 'big.bin': big })
    const plan = await scan(root)
    drive.chunkSize = 16 * 1024
    drive.chunkDelayMs = 5
    const controller = new AbortController()
    const first = await run(plan, {
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'bytes' && e.doneBytes > 32 * 1024) controller.abort()
      },
    })
    expect(first.status).toBe('aborted')
    drive.ignoreRange = true // the Range request is answered 200, so the writer restarts from 0
    const events: DownloadEvent[] = []

    const summary = await run(plan, { onEvent: (e) => events.push(e) })

    expect(summary.status).toBe('complete')
    expect(await fs.readFile(abs('Root/big.bin'))).toEqual(big)
    expectMonotonicProgress(events, plan.totalBytes)
  })

  it('rejects with the onEvent error and attempts no later entry', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.bin': randomBytes(128 * 1024), 'b.txt': 'b', 'c.txt': 'c' })
    const plan = await scan(root)
    const aId = entryOf(plan, 'Root/a.bin').fileId
    drive.chunkSize = 16 * 1024
    drive.chunkDelayMs = 5
    const boom = new Error('renderer gone')
    const started: number[] = []
    let bytesEvents = 0

    await expect(
      run(plan, {
        onEvent: (e) => {
          if (e.type === 'file_start') started.push(e.index)
          if (e.type === 'bytes' && ++bytesEvents === 2) throw boom
        },
      }),
    ).rejects.toBe(boom)

    expect(started).toEqual([0])
    expect(transfers().map((r) => r.path)).toEqual([drive.filePath(aId)])
    await expect(fs.lstat(abs('Root/a.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects with an onEvent error thrown in file_done before the next entry', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.txt': 'a', 'b.txt': 'b' })
    const plan = await scan(root)
    const boom = new Error('listener failed')
    const started: number[] = []

    await expect(
      run(plan, {
        onEvent: (e) => {
          if (e.type === 'file_start') started.push(e.index)
          if (e.type === 'file_done') throw boom
        },
      }),
    ).rejects.toBe(boom)

    expect(started).toEqual([0])
    expect(transfers()).toHaveLength(1)
  })

  it('stops with destination_lost when the root folder is moved away mid-run', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { '1.txt': 'one', '2.txt': 'two', '3.txt': 'three' })
    const plan = await scan(root)
    const moved = path.join(tmp, 'RootMoved')

    const summary = await run(plan, {
      onEvent: (e) => {
        if (e.type === 'file_done') renameSync(abs('Root'), moved)
      },
    })

    expect(summary.status).toBe('destination_lost')
    expect(summary.results.map((r) => r.outcome)).toEqual(['downloaded'])
    await expect(fs.lstat(abs('Root'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await listFiles(moved)).filter((f) => !f.startsWith('.'))).toEqual(['1.txt'])
  })

  it('stops with destination_lost when the chosen directory is replaced by an empty one (stale mount point)', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { '1.txt': 'one', '2.txt': 'two' })
    const plan = await scan(root)
    const moved = path.join(tmp, 'Unplugged')

    const summary = await run(plan, {
      onEvent: (e) => {
        if (e.type === 'file_done') {
          renameSync(chosenDir, moved)
          mkdirSync(chosenDir)
        }
      },
    })

    expect(summary.status).toBe('destination_lost')
    expect(await fs.readdir(chosenDir)).toEqual([])
  })

  it('picks distinct free names for many changed copies in one folder', async () => {
    const root = drive.addFolder('Root')
    const ids = drive.addTree(root, { 'A.mp4': 'a1', 'B.mp4': 'b1', 'C.mp4': 'c1', 'D.mp4': 'd1' })
    expect((await run(await scan(root))).status).toBe('complete')
    await fs.writeFile(abs('Root/B (2).mp4'), 'foreign')
    for (const [name, id] of ids) drive.updateFile(id, { bytes: `${name} v2`, modifiedTime: LATER })
    const plan = await scan(root)

    const summary = await run(plan)

    expect(summary.status).toBe('complete')
    expect(summary.results.map((r) => [r.outcome, r.localRelPath])).toEqual([
      ['changed_copy', 'Root/A (2).mp4'],
      ['changed_copy', 'Root/B (3).mp4'],
      ['changed_copy', 'Root/C (2).mp4'],
      ['changed_copy', 'Root/D (2).mp4'],
    ])
    expect(await read('Root/B (2).mp4')).toBe('foreign')
    expect(await read('Root/B (3).mp4')).toBe('B.mp4 v2')
  })

  it('treats a file with the same md5 and size as the same version even when modifiedTime changed', async () => {
    const root = drive.addFolder('Root')
    const fileId = drive.addFile(root, 'v.mp4', 'same bytes')
    const docId = drive.addGoogleDoc(root, 'Doc', { [DOCX_MIME]: 'docx v1' })
    expect((await run(await scan(root))).status).toBe('complete')
    const journalBefore = await fs.readFile(journalPath(abs('Root')), 'utf8')
    drive.updateFile(fileId, { modifiedTime: LATER })
    drive.updateFile(docId, { modifiedTime: LATER })
    const plan = await scan(root)
    drive.clearLog()

    const summary = await run(plan)

    expect(result(summary, 'Root/v.mp4')).toMatchObject({ outcome: 'already', localRelPath: 'Root/v.mp4' })
    // exports keep the modifiedTime rule
    expect(result(summary, 'Root/Doc.docx')).toMatchObject({ outcome: 'changed_copy', localRelPath: 'Root/Doc (2).docx' })
    expect(transfers().map((r) => r.path)).toEqual([drive.filePath(docId, 'export')])
    const journalAfter = await fs.readFile(journalPath(abs('Root')), 'utf8')
    expect(journalAfter.startsWith(journalBefore)).toBe(true)
    expect(journalAfter.split('\n').filter((l) => l.includes(fileId))).toHaveLength(1)
  })

  it('accepts a local mtime shifted by exactly one hour (FAT daylight saving) without re-hashing', async () => {
    const root = drive.addFolder('Root')
    const id = drive.addFile(root, 'v.mp4', 'video')
    const plan = await scan(root)
    expect((await run(plan)).status).toBe('complete')
    const record = (await loadJournal(abs('Root'))).get(id)
    if (!record) throw new Error('no journal record')
    const seconds = 1_780_000_000
    await fs.utimes(abs('Root/v.mp4'), seconds, seconds)
    await appendRecord(abs('Root'), { ...record, localMtimeMs: seconds * 1000 + 3_600_000 })
    const lines = await journalLines('Root')

    const shifted = await run(plan)

    expect(result(shifted, 'Root/v.mp4').outcome).toBe('already')
    expect(await journalLines('Root')).toBe(lines)

    // any other difference is not trusted: the file is re-checked by MD5 and adopted with a new record
    await appendRecord(abs('Root'), { ...record, localMtimeMs: seconds * 1000 + 1_800_000 })
    const other = await run(plan)
    expect(result(other, 'Root/v.mp4').outcome).toBe('already')
    expect(await journalLines('Root')).toBe(lines + 2)
    expect(transfers().filter((r) => r.query['alt'] === 'media')).toHaveLength(1)
  })
  it('downloads identical content once and reports later copies as duplicates of it', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.mp4': 'same bytes', 'b.mp4': 'other', Kopie: { 'a.mp4': 'same bytes' } })
    const plan = await scan(root)
    const events: DownloadEvent[] = []

    const summary = await run(plan, { onEvent: (e) => events.push(e) })

    expect(summary.status).toBe('complete')
    expect(result(summary, 'Root/Kopie/a.mp4')).toMatchObject({
      outcome: 'duplicate',
      localRelPath: 'Root/Kopie/a.mp4',
      bytes: 0,
      reason: 'stejný obsah jako Root/a.mp4',
    })
    expect(transfers()).toHaveLength(2)
    await expect(fs.lstat(abs('Root/Kopie/a.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(summary.downloadedBytes).toBe(plan.totalBytes)
    expectMonotonicProgress(events, plan.totalBytes)
  })

  it('downloads a duplicate when the first copy fails, and later copies point at it', async () => {
    const root = drive.addFolder('Root')
    const ids = drive.addTree(root, { '1.mp4': 'same', '2.mp4': 'same', '3.mp4': 'same' })
    drive.scriptFailures(drive.filePath(ids.get('1.mp4') ?? ''), [{ status: 403, reason: 'cannotDownloadFile' }])
    const plan = await scan(root)
    const events: DownloadEvent[] = []

    const summary = await run(plan, { onEvent: (e) => events.push(e) })

    expect(summary.results.map((r) => r.outcome)).toEqual(['failed', 'downloaded', 'duplicate'])
    expect(result(summary, 'Root/3.mp4').reason).toBe('stejný obsah jako Root/2.mp4')
    expect(await read('Root/2.mp4')).toBe('same')
    expect(summary.status).toBe('incomplete')
    expectMonotonicProgress(events, plan.totalBytes)
  })

  it('keeps duplicates skipped on a second run, with zero download requests', async () => {
    const root = drive.addFolder('Root')
    drive.addTree(root, { 'a.mp4': 'same bytes', 'b.mp4': 'same bytes' })
    const plan = await scan(root)
    await run(plan)
    drive.clearLog()

    const summary = await run(plan)

    expect(summary.results.map((r) => r.outcome)).toEqual(['already', 'duplicate'])
    expect(summary.status).toBe('complete')
    expect(transfers()).toHaveLength(0)
  })
})
