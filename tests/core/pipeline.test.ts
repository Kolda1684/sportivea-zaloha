import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ffmpegPath } from '../../src/core/bin'
import type { Classifier, ClassifyInput, ClassifyResult } from '../../src/core/classifier'
import { sha256File } from '../../src/core/copy'
import { Journal } from '../../src/core/journal'
import { runCard, type RunEvent, type RunOptions, type RunSummary } from '../../src/core/pipeline'
import { DEFAULT_TEMPLATES } from '../../src/core/templates'
import { ensureFixtureClips } from '../fixtures/make-clips'

const TEMPLATE = DEFAULT_TEMPLATES[0]!
const CLIP_DIR = 'PRIVATE/M4ROOT/CLIP'
const SONNET_USAGE = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, model: 'claude-sonnet-5-5' }

let work: string
let clips: { c1: string; c2: string; c3: string }
let root: string
let cardRoot: string
let eventDir: string
let journalFile: string

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 60_000 }, (err, _o, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${stderr.slice(-400)}`))
      else resolve()
    })
  })
}

/** Remuxes a fixture with a creation_time so that marker/TOP detection has real timestamps. */
async function dated(src: string, name: string, iso: string): Promise<string> {
  const out = path.join(work, name)
  await ffmpeg(['-i', src, '-c', 'copy', '-metadata', `creation_time=${iso}`, '-f', 'mp4', out])
  return out
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-pipeline-clips-'))
  const f = await ensureFixtureClips()
  clips = {
    c1: await dated(f.bright, 'c1.mp4', '2026-10-01T10:00:00Z'), // 5 s, ends 10:00:05
    c2: await dated(f.black, 'c2.mp4', '2026-10-01T10:00:07Z'), // marker, 2 s after c1 ended
    c3: await dated(f.bright, 'c3.mp4', '2026-10-01T10:05:00Z'),
  }
})

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

async function put(rel: string, content: Buffer | string | { copyFrom: string }): Promise<void> {
  const abs = path.join(cardRoot, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  if (typeof content === 'object' && 'copyFrom' in content) await fs.copyFile(content.copyFrom, abs)
  else await fs.writeFile(abs, content)
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-pipeline-'))
  cardRoot = path.join(root, 'SONY')
  eventDir = path.join(root, 'drive', 'Akce')
  journalFile = path.join(root, 'journal.jsonl')
  await put(`${CLIP_DIR}/C0001.MP4`, { copyFrom: clips.c1 })
  await put(`${CLIP_DIR}/C0002.MP4`, { copyFrom: clips.c2 })
  await put(`${CLIP_DIR}/C0003.MP4`, { copyFrom: clips.c3 })
  await put(`${CLIP_DIR}/C0001M01.XML`, '<NonRealTimeMeta/>')
  await put('DCIM/100MSDCF/DSC00001.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  await put(`${CLIP_DIR}/._C0001.MP4`, 'appledouble')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function fakeClassifier(overrides: Record<string, ClassifyResult> = {}): Classifier & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async classify(input: ClassifyInput): Promise<ClassifyResult> {
      seen.push(input.fileName)
      const o = overrides[input.fileName]
      if (o) return o
      const description = input.fileName.startsWith('C0001') ? 'gol' : 'sance'
      return { category: 'Zápas', description, confidence: 'high', ok: true, usage: SONNET_USAGE }
    },
  }
}

async function baseOptions(over: Partial<RunOptions> = {}): Promise<RunOptions> {
  return {
    cardRoot,
    eventDir,
    template: TEMPLATE,
    roster: [],
    classifier: fakeClassifier(),
    journal: await Journal.load(journalFile),
    waitForSpace: async () => {},
    ...over,
  }
}

async function run(over: Partial<RunOptions> = {}, signal?: AbortSignal): Promise<{ summary: RunSummary; events: RunEvent[] }> {
  const events: RunEvent[] = []
  const summary = await runCard(await baseOptions(over), (e) => events.push(e), signal)
  return { summary, events }
}

async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)))
    else out.push(r)
  }
  return out.sort()
}

const media = (files: string[]): string[] => files.filter((f) => !f.startsWith('_trideni_'))

async function readCsv(p: string): Promise<string[][]> {
  const text = await fs.readFile(p, 'utf8')
  expect(text.charCodeAt(0)).toBe(0xfeff)
  return text
    .slice(1)
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .map((l) => l.split(';'))
}

function enoent(): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error('ENOENT: card removed')
  e.code = 'ENOENT'
  return e
}

describe('runCard', () => {
  it('sorts a card into the event folder and writes the mapping CSV', { timeout: 120_000 }, async () => {
    const { summary, events } = await run()

    expect(media(await listFiles(eventDir))).toEqual([
      'Zápas/C0001_TOP_gol.MP4',
      'Zápas/C0003_sance.MP4',
      '_ostatni/DCIM/100MSDCF/DSC00001.JPG',
      `_ostatni/${CLIP_DIR}/C0001M01.XML`,
    ])
    expect(await sha256File(path.join(eventDir, 'Zápas/C0001_TOP_gol.MP4'))).toBe(await sha256File(clips.c1))

    expect(summary).toMatchObject({
      top: 1,
      markers: 1,
      orphanMarkers: 0,
      others: 2,
      unclassified: 0,
      alreadyUploaded: 0,
      verifyFailed: [],
      lowConfidence: [],
      status: 'ok',
      perFolder: { Zápas: 2 },
    })
    expect(summary.costUsd).toBeCloseTo(4, 6)
    expect(path.dirname(summary.csvPath)).toBe(eventDir)
    expect(path.basename(summary.csvPath)).toMatch(/^_trideni_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.csv$/)

    const rows = await readCsv(summary.csvPath)
    expect(rows[0]).toEqual(['puvodni_nazev', 'novy_nazev', 'slozka', 'poznamka'])
    expect(rows).toHaveLength(6) // header + 5 files; the ._ file is not listed
    const byName = new Map(rows.slice(1).map((r) => [r[0], r]))
    expect(byName.get('C0001.MP4')).toMatchObject({ 1: 'C0001_TOP_gol.MP4', 2: 'Zápas' })
    expect(byName.get('C0002.MP4')?.[2]).toBe('(nekopírováno)')
    expect(byName.get('C0002.MP4')?.[3]).toContain('černá značka')
    expect(byName.get('C0001M01.XML')?.[2]).toBe(`_ostatni/${CLIP_DIR}`)

    expect(events[0]).toMatchObject({ type: 'scanned', videos: 3, others: 2 })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(events.filter((e) => e.type === 'copied')).toHaveLength(4)
    const tops = events.filter((e) => e.type === 'classified' && e.top)
    expect(tops.map((e) => e.type === 'classified' && e.relPath)).toEqual([`${CLIP_DIR}/C0001.MP4`])
  })

  it('classifies only non-marker clips', { timeout: 120_000 }, async () => {
    const classifier = fakeClassifier()
    await run({ classifier })
    expect([...classifier.seen].sort()).toEqual(['C0001.MP4', 'C0003.MP4'])
  })

  it('puts a clip whose classification failed into _nezařazeno under its original name', { timeout: 120_000 }, async () => {
    const failed: ClassifyResult = { category: '_nezařazeno', description: '', confidence: 'low', ok: false, error: 'API down' }
    const { summary } = await run({ classifier: fakeClassifier({ 'C0003.MP4': failed }) })
    expect(media(await listFiles(eventDir))).toContain('_nezařazeno/C0003.MP4')
    expect(summary.unclassified).toBe(1)
    expect(summary.perFolder).toEqual({ Zápas: 1, _nezařazeno: 1 })
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[3]).toContain('API down')
  })

  it('reports low-confidence clips', { timeout: 120_000 }, async () => {
    const low: ClassifyResult = { category: 'Zápas', description: 'sance', confidence: 'low', ok: true }
    const { summary } = await run({ classifier: fakeClassifier({ 'C0003.MP4': low }) })
    expect(summary.lowConfidence).toEqual([`${CLIP_DIR}/C0003.MP4`])
  })

  it('never uses a category that is not a plain folder name', { timeout: 120_000 }, async () => {
    const evil: ClassifyResult = { category: '../../x', description: 'sance', confidence: 'high', ok: true }
    const { summary } = await run({ classifier: fakeClassifier({ 'C0003.MP4': evil }) })
    expect(media(await listFiles(eventDir))).toContain('_nezařazeno/C0003_sance.MP4')
    expect(summary.unclassified).toBe(1)
    expect((await listFiles(root)).some((f) => f.includes('x/'))).toBe(false)
  })

  it('does nothing new on a second run with the same journal and does not classify again', { timeout: 120_000 }, async () => {
    const journal = await Journal.load(journalFile)
    const first = await run({ journal })
    const before = media(await listFiles(eventDir))
    const classifier = fakeClassifier()
    const second = await run({ journal, classifier })

    expect(media(await listFiles(eventDir))).toEqual(before)
    expect(second.summary.alreadyUploaded).toBe(4)
    expect(second.summary.status).toBe('ok')
    expect(second.summary.perFolder).toEqual({ Zápas: 2 })
    expect(classifier.seen).toEqual([])
    expect(second.summary.csvPath).not.toBe(first.summary.csvPath) // add-only: a new CSV, never overwritten
    expect(await fs.readFile(first.summary.csvPath, 'utf8')).toContain('C0001_TOP_gol.MP4')
    const rows = await readCsv(second.summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')).toMatchObject({ 1: 'C0003_sance.MP4', 2: 'Zápas' })
  })

  it('counts content-identical files at the destination as already uploaded', { timeout: 120_000 }, async () => {
    await run()
    // a fresh journal (e.g. another machine) knows nothing; the copy step finds identical files
    await fs.rm(journalFile)
    const { summary } = await run({ journal: await Journal.load(journalFile) })
    expect(summary.alreadyUploaded).toBe(4)
    expect(media(await listFiles(eventDir))).toHaveLength(4)
  })

  it('stops when the card disappears, keeps what is verified, and resumes on re-run', { timeout: 120_000 }, async () => {
    const journal = await Journal.load(journalFile)
    const openRead = (p: string): NodeJS.ReadableStream => {
      if (p.endsWith('C0003.MP4')) throw enoent()
      return createReadStream(p)
    }
    const first = await run({ journal, openRead })

    expect(first.summary.status).toBe('card_removed')
    expect(first.events.some((e) => e.type === 'card_removed')).toBe(true)
    expect(first.events.at(-1)).toMatchObject({ type: 'done' })
    const afterFirst = await listFiles(eventDir)
    expect(media(afterFirst)).toEqual(['Zápas/C0001_TOP_gol.MP4'])
    expect(afterFirst.some((f) => f.includes('.partial'))).toBe(false)
    expect(await sha256File(path.join(eventDir, 'Zápas/C0001_TOP_gol.MP4'))).toBe(await sha256File(clips.c1))
    const rows = await readCsv(first.summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[2]).toBe('(nekopírováno)')
    expect(rows.find((r) => r[0] === 'C0002.MP4')?.[3]).toContain('černá značka')

    const second = await run({ journal })
    expect(second.summary.status).toBe('ok')
    expect(second.summary.alreadyUploaded).toBe(1)
    expect(media(await listFiles(eventDir))).toEqual([
      'Zápas/C0001_TOP_gol.MP4',
      'Zápas/C0003_sance.MP4',
      '_ostatni/DCIM/100MSDCF/DSC00001.JPG',
      `_ostatni/${CLIP_DIR}/C0001M01.XML`,
    ])
  })

  it('treats a vanished card at the first read (before probing) as card removal too', { timeout: 120_000 }, async () => {
    const { summary, events } = await run({ cardRoot: path.join(root, 'GONE') })
    expect(summary.status).toBe('card_removed')
    expect(events.some((e) => e.type === 'card_removed')).toBe(true)
    expect(await readCsv(summary.csvPath)).toHaveLength(1)
  })

  it('keeps an existing different file and adds the new one with the camera tag', { timeout: 120_000 }, async () => {
    await fs.mkdir(path.join(eventDir, 'Zápas'), { recursive: true })
    const existing = path.join(eventDir, 'Zápas/C0001_TOP_gol.MP4')
    await fs.writeFile(existing, 'someone else')
    const { summary } = await run()

    expect(await fs.readFile(existing, 'utf8')).toBe('someone else')
    expect(media(await listFiles(eventDir))).toContain('Zápas/C0001-SONY_TOP_gol.MP4')
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0001.MP4')?.[1]).toBe('C0001-SONY_TOP_gol.MP4')
  })

  it('reports a failed verification, continues with the other files and ends with verify_failed', { timeout: 120_000 }, async () => {
    const hashFile = async (p: string): Promise<string> => (p.includes('C0003') ? 'bad-hash' : sha256File(p))
    const { summary } = await run({ hashFile })

    expect(summary.status).toBe('verify_failed')
    expect(summary.verifyFailed).toEqual([`${CLIP_DIR}/C0003.MP4`])
    const files = media(await listFiles(eventDir))
    expect(files).toContain('Zápas/C0001_TOP_gol.MP4')
    expect(files).toContain(`_ostatni/${CLIP_DIR}/C0001M01.XML`)
    expect(files.some((f) => f.endsWith('.partial'))).toBe(true) // the failed temp is kept for inspection
    expect(files).not.toContain('Zápas/C0003_sance.MP4')
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[3]).toContain('ověření')
  })

  it('reports an unexpected per-file error and carries on', { timeout: 120_000 }, async () => {
    const openRead = (p: string): NodeJS.ReadableStream => {
      if (p.endsWith('DSC00001.JPG')) throw Object.assign(new Error('boom'), { code: 'EACCES' })
      return createReadStream(p)
    }
    const { summary } = await run({ openRead })
    expect(summary.status).toBe('verify_failed')
    expect(summary.verifyFailed).toHaveLength(1)
    expect(summary.verifyFailed[0]).toContain('DSC00001.JPG')
    expect(summary.verifyFailed[0]).toContain('boom')
    expect(media(await listFiles(eventDir))).toContain('Zápas/C0003_sance.MP4')
  })

  it('stops between files when aborted and still writes the CSV', { timeout: 120_000 }, async () => {
    const controller = new AbortController()
    const events: RunEvent[] = []
    const summary = await runCard(
      await baseOptions(),
      (e) => {
        events.push(e)
        if (e.type === 'copied') controller.abort()
      },
      controller.signal,
    )
    expect(media(await listFiles(eventDir))).toEqual(['Zápas/C0001_TOP_gol.MP4'])
    expect(summary.status).toBe('ok')
    const rows = await readCsv(summary.csvPath)
    expect(rows).toHaveLength(6)
    expect(rows.find((r) => r[0] === 'C0003.MP4')?.[2]).toBe('(nekopírováno)')
  })

  it('lists an orphan marker without a TOP clip', { timeout: 120_000 }, async () => {
    await fs.rm(path.join(cardRoot, CLIP_DIR, 'C0001.MP4'))
    const { summary } = await run()
    expect(summary).toMatchObject({ top: 0, markers: 1, orphanMarkers: 1 })
    const rows = await readCsv(summary.csvPath)
    expect(rows.find((r) => r[0] === 'C0002.MP4')?.[3]).toContain('černá značka (bez TOP)')
  })
})
