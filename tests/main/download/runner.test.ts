import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadEvent, DownloadOptions, DownloadSummary, EntryResult } from '../../../src/core/download/downloader'
import { DriveError } from '../../../src/core/download/drive'
import type { Preflight } from '../../../src/core/download/preflight'
import type { DownloadPlan, PlanEntry } from '../../../src/core/download/types'
import { Runner, type RunnerDeps } from '../../../src/main/download/runner'
import type { MainEvents, RunDone } from '../../../src/shared/download-ipc'

const LINK = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp'

function entry(name: string, size = 10, kind: PlanEntry['kind'] = 'file'): PlanEntry {
  return {
    fileId: `id-${name}-0000000`,
    drivePath: `Klient/${name}`,
    localRelPath: `Klient/${name}`,
    kind,
    size,
    md5: null,
    mimeType: 'video/mp4',
    exportMime: null,
    modifiedTime: '2026-01-01T00:00:00.000Z',
    skipReason: kind === 'skip' ? 'zástupce (nestahuje se)' : null,
    blocked: false,
    duplicate: false,
  }
}

const PLAN: DownloadPlan = {
  rootName: 'Klient',
  entries: [entry('a.mp4'), entry('b.mp4'), entry('odkaz', 0, 'skip')],
  folders: ['Klient', 'Klient/Sub'],
  totalBytes: 20,
  fileCount: 2,
  duplicateCount: 0,
  duplicateBytes: 0,
}

const result = (e: PlanEntry, outcome: EntryResult['outcome'], reason: string | null = null): EntryResult => ({
  entry: e,
  outcome,
  localRelPath: e.localRelPath,
  md5: null,
  bytes: outcome === 'failed' || outcome === 'skipped' ? 0 : (e.size ?? 0),
  reason,
})

type Sent = { channel: keyof MainEvents; payload: unknown }

let tmp: string
let chosenDir: string
let sent: Sent[]
let logs: string[]
let blocker: { started: number; stopped: number[] }
let clock: number
let preflightProblem: string | null
let downloads: DownloadOptions[]
let downloadImpl: (opts: DownloadOptions) => Promise<DownloadSummary>

function summary(status: DownloadSummary['status'], results: EntryResult[]): DownloadSummary {
  return { status, results, downloadedBytes: 20, startedAt: '2026-10-27T10:00:00.000Z', finishedAt: '2026-10-27T10:05:00.000Z' }
}

function makeRunner(over: Partial<RunnerDeps> = {}): Runner {
  let ids = 0
  return new Runner({
    send: (channel, payload) => {
      sent.push({ channel, payload })
    },
    powerSaveBlocker: {
      start: (type) => {
        expect(type).toBe('prevent-app-suspension')
        blocker.started += 1
        return 40 + blocker.started
      },
      stop: (id) => {
        blocker.stopped.push(id)
        return true
      },
    },
    makeClient: () => ({
      getItem: () => Promise.reject(new Error('unused')),
      listChildren: () => Promise.reject(new Error('unused')),
      download: () => Promise.reject(new Error('unused')),
      exportFile: () => Promise.reject(new Error('unused')),
    }),
    isSignedIn: async () => true,
    scan: async (_client, folderId, onProgress) => {
      expect(folderId).toBe('1AbCdEfGhIjKlMnOp')
      onProgress?.({ files: 2, bytes: 20 })
      return PLAN
    },
    preflight: async ({ chosenDir: dir, plan }): Promise<Preflight> => ({
      destRoot: path.join(dir, plan.rootName),
      state: 'new',
      lastRunAt: null,
      freeBytes: 1e12,
      neededBytes: 20,
      problem: preflightProblem,
      warning: null,
    }),
    download: async (opts) => {
      downloads.push(opts)
      return downloadImpl(opts)
    },
    now: () => clock,
    newId: () => `scan-${++ids}`,
    log: (m) => logs.push(m),
    ...over,
  })
}

const doneOf = (): RunDone[] => sent.filter((s) => s.channel === 'download.run:done').map((s) => s.payload as RunDone)
const eventsOf = (): DownloadEvent[] => sent.filter((s) => s.channel === 'download.run:event').map((s) => s.payload as DownloadEvent)

async function scanned(runner: Runner): Promise<string> {
  const r = await runner.scan(LINK)
  if (!r.ok) throw new Error(r.error)
  return r.scanId
}

async function ready(runner: Runner): Promise<string> {
  const scanId = await scanned(runner)
  const picked = await runner.setDestination(scanId, chosenDir)
  if (!picked.ok) throw new Error(picked.error)
  return scanId
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-test-'))
  chosenDir = path.join(tmp, 'Disk')
  await fs.mkdir(chosenDir)
  sent = []
  logs = []
  blocker = { started: 0, stopped: [] }
  clock = 0
  preflightProblem = null
  downloads = []
  downloadImpl = async (opts) => {
    await fs.mkdir(path.join(opts.chosenDir, opts.plan.rootName), { recursive: true })
    return summary('complete', [result(PLAN.entries[0]!, 'downloaded'), result(PLAN.entries[1]!, 'already'), result(PLAN.entries[2]!, 'skipped')])
  }
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('scan', () => {
  it('returns a summary, keeps the plan in main and forwards progress', async () => {
    const runner = makeRunner()
    const r = await runner.scan(LINK)
    expect(r).toEqual({
      ok: true,
      scanId: 'scan-1',
      plan: { rootName: 'Klient', fileCount: 2, folderCount: 1, totalBytes: 20, skipped: 1, duplicateCount: 0, duplicateBytes: 0 },
    })
    expect(sent).toContainEqual({ channel: 'download.drive:scanProgress', payload: { files: 2, bytes: 20 } })
    expect(runner.hasScan('scan-1')).toBe(true)
  })

  it('rejects something that is not a folder link', async () => {
    const r = await makeRunner().scan('https://example.com/folders/abc')
    expect(r).toEqual({ ok: false, error: 'Tohle není odkaz na složku Google Disku.' })
  })

  it('asks to sign in first', async () => {
    const r = await makeRunner({ isSignedIn: async () => false }).scan(LINK)
    expect(r).toEqual({ ok: false, error: 'Nejdřív se přihlas přes Google.' })
  })

  it('maps Drive errors to Czech messages', async () => {
    const runner = makeRunner({
      scan: async () => {
        throw new DriveError('auth', 'x')
      },
    })
    expect(await runner.scan(LINK)).toEqual({ ok: false, error: 'Přihlášení vypršelo. Přihlas se znovu.' })
  })
})

describe('destination', () => {
  it('unknown scanId is refused in Czech', async () => {
    const r = await makeRunner().setDestination('nope', chosenDir)
    expect(r).toEqual({ ok: false, error: 'Složka už není načtená. Načti ji znovu.' })
  })

  it('returns the preflight for the picked directory', async () => {
    const runner = makeRunner()
    const scanId = await scanned(runner)
    const r = await runner.setDestination(scanId, chosenDir)
    expect(r).toMatchObject({ ok: true, preflight: { destRoot: path.join(chosenDir, 'Klient'), problem: null } })
  })
})

describe('run:start', () => {
  it('refuses an unknown scan', async () => {
    expect(await makeRunner().start('nope')).toEqual({ ok: false, error: 'Složka už není načtená. Načti ji znovu.' })
  })

  it('refuses without a picked destination', async () => {
    const runner = makeRunner()
    const scanId = await scanned(runner)
    expect(await runner.start(scanId)).toEqual({ ok: false, error: 'Nejdřív vyber cíl na externím disku.' })
    expect(downloads).toHaveLength(0)
  })

  it('refuses when preflight reports a problem (checked again at start)', async () => {
    const runner = makeRunner()
    const scanId = await ready(runner)
    preflightProblem = 'Na disku chybí 1,0 GB.'
    expect(await runner.start(scanId)).toEqual({ ok: false, error: 'Na disku chybí 1,0 GB.' })
    expect(downloads).toHaveLength(0)
    expect(blocker.started).toBe(0)
  })

  it('refuses while a run is active, also for a double click', async () => {
    let release: () => void = () => undefined
    downloadImpl = async (opts) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return summary('complete', opts.plan.entries.map((e) => result(e, e.kind === 'skip' ? 'skipped' : 'downloaded')))
    }
    const runner = makeRunner()
    const scanId = await ready(runner)
    expect(runner.isRunning()).toBe(false)
    const [first, second] = await Promise.all([runner.start(scanId), runner.start(scanId)])
    expect(runner.isRunning()).toBe(true)
    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: false, error: 'Stahování už běží.' })
    await vi.waitFor(() => expect(downloads).toHaveLength(1))
    expect(await runner.retryFailed()).toEqual({ ok: false, error: 'Stahování už běží.' })
    release()
    await runner.idle()
    expect(runner.isRunning()).toBe(false)
    expect(downloads).toHaveLength(1)
  })

  it('starts and stops the power-save blocker around the run, also when the run crashes', async () => {
    const runner = makeRunner()
    const scanId = await ready(runner)
    await runner.start(scanId)
    await runner.idle()
    expect(blocker).toEqual({ started: 1, stopped: [41] })

    downloadImpl = async () => {
      throw new Error('bug')
    }
    await runner.start(scanId)
    await runner.idle()
    expect(blocker).toEqual({ started: 2, stopped: [41, 42] })
    const done = doneOf()[1]
    expect(done?.status).toBe('incomplete')
    expect(done?.manifestPath).toBeNull()
  })

  it('sends run:done with counts, failed files and the manifest path; the manifest is on disk', async () => {
    downloadImpl = async (opts) => {
      await fs.mkdir(path.join(opts.chosenDir, 'Klient'), { recursive: true })
      return summary('incomplete', [
        result(PLAN.entries[0]!, 'downloaded'),
        result(PLAN.entries[1]!, 'failed', 'výpadek spojení, zkus znovu'),
        result(PLAN.entries[2]!, 'skipped', 'zástupce (nestahuje se)'),
      ])
    }
    const runner = makeRunner()
    const scanId = await ready(runner)
    await runner.start(scanId)
    await runner.idle()
    const [done] = doneOf()
    expect(done).toMatchObject({
      status: 'incomplete',
      counts: { downloaded: 1, exported: 0, already: 0, changed_copy: 0, skipped: 1, failed: 1 },
      downloadedBytes: 20,
      startedAt: '2026-10-27T10:00:00.000Z',
      finishedAt: '2026-10-27T10:05:00.000Z',
      failed: [{ path: 'Klient/b.mp4', reason: 'výpadek spojení, zkus znovu' }],
      skipped: [{ path: 'Klient/odkaz', reason: 'zástupce (nestahuje se)' }],
    })
    expect(done?.manifestPath).toMatch(/_seznam_souboru_.*\.csv$/)
    expect(path.dirname(done?.manifestPath ?? '')).toBe(path.join(chosenDir, 'Klient'))
    await expect(fs.stat(done?.manifestPath ?? '')).resolves.toBeTruthy()
    expect(runner.destRootToShow()).toBe(path.join(chosenDir, 'Klient'))
  })

  it('writes the manifest for a stopped run too', async () => {
    downloadImpl = async (opts) => {
      await fs.mkdir(path.join(opts.chosenDir, 'Klient'), { recursive: true })
      return summary('aborted', [result(PLAN.entries[0]!, 'downloaded')])
    }
    const runner = makeRunner()
    await runner.start(await ready(runner))
    await runner.idle()
    expect(doneOf()[0]?.status).toBe('aborted')
    expect(doneOf()[0]?.manifestPath).not.toBeNull()
  })

  it('skips the manifest when the destination root does not exist', async () => {
    const writeManifest = vi.fn(async () => 'x')
    downloadImpl = async () => summary('destination_lost', [])
    const runner = makeRunner({ writeManifest })
    await runner.start(await ready(runner))
    await runner.idle()
    expect(writeManifest).not.toHaveBeenCalled()
    expect(doneOf()[0]).toMatchObject({ status: 'destination_lost', manifestPath: null })
  })

  it('skips the manifest when the destination root is a symlink', async () => {
    const writeManifest = vi.fn(async () => 'x')
    const elsewhere = path.join(tmp, 'elsewhere')
    await fs.mkdir(elsewhere)
    downloadImpl = async (opts) => {
      await fs.symlink(elsewhere, path.join(opts.chosenDir, 'Klient'))
      return summary('complete', [])
    }
    const runner = makeRunner({ writeManifest })
    await runner.start(await ready(runner))
    await runner.idle()
    expect(writeManifest).not.toHaveBeenCalled()
  })

  it('a manifest failure is not fatal: manifestPath null and a log line without paths', async () => {
    const runner = makeRunner({
      writeManifest: async () => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${chosenDir}/Klient/x.csv'`), { code: 'EACCES' })
      },
    })
    await runner.start(await ready(runner))
    await runner.idle()
    expect(doneOf()[0]).toMatchObject({ status: 'complete', manifestPath: null })
    expect(logs.join('\n')).toContain('EACCES')
    expect(logs.join('\n')).not.toContain(chosenDir)
  })

  it('throttles bytes events to 250 ms but always forwards the last one', async () => {
    downloadImpl = async (opts) => {
      const emit = (e: DownloadEvent): void => opts.onEvent?.(e)
      const e0 = opts.plan.entries[0]!
      emit({ type: 'file_start', index: 0, entry: e0 })
      emit({ type: 'bytes', doneBytes: 1, totalBytes: 20 }) // t=0 sent
      clock = 100
      emit({ type: 'bytes', doneBytes: 2, totalBytes: 20 }) // dropped
      clock = 200
      emit({ type: 'bytes', doneBytes: 3, totalBytes: 20 }) // dropped
      clock = 260
      emit({ type: 'bytes', doneBytes: 4, totalBytes: 20 }) // sent
      clock = 300
      emit({ type: 'bytes', doneBytes: 20, totalBytes: 20 }) // pending, flushed at the end
      emit({ type: 'file_done', result: result(e0, 'downloaded') })
      return summary('complete', [])
    }
    const runner = makeRunner()
    await runner.start(await ready(runner))
    await runner.idle()
    // The held-back bytes event of file 0 goes out before its file_done.
    const order = eventsOf().map((e) => (e.type === 'bytes' ? `bytes:${e.doneBytes}` : e.type))
    expect(order).toEqual(['file_start', 'bytes:1', 'bytes:4', 'bytes:20', 'file_done'])
    expect(doneOf()).toHaveLength(1)
  })

  it('a failing send (closed window) never stops the run', async () => {
    downloadImpl = async (opts) => {
      opts.onEvent?.({ type: 'file_start', index: 0, entry: opts.plan.entries[0]! })
      opts.onEvent?.({ type: 'bytes', doneBytes: 5, totalBytes: 20 })
      return summary('complete', [])
    }
    const runner = makeRunner({
      send: () => {
        throw new Error('Object has been destroyed')
      },
    })
    await runner.start(await ready(runner))
    await runner.idle()
    expect(blocker.stopped).toEqual([41])
    expect(downloads).toHaveLength(1)
    // A new run can start: the runner is idle again.
    expect(await runner.retryFailed()).toEqual({ ok: true })
    await runner.idle()
  })

  it('run:retryFailed re-runs the same plan and destination', async () => {
    const runner = makeRunner()
    const scanId = await ready(runner)
    expect(await runner.retryFailed()).toEqual({ ok: false, error: 'Zatím není co opakovat.' })
    await runner.start(scanId)
    await runner.idle()
    // A newer scan does not change what is retried.
    await scanned(runner)
    expect(await runner.retryFailed()).toEqual({ ok: true })
    await runner.idle()
    expect(downloads).toHaveLength(2)
    expect(downloads[1]?.plan).toBe(downloads[0]?.plan)
    expect(downloads[1]?.chosenDir).toBe(chosenDir)
    // Only a retry asks Drive again for files whose owner disabled downloading.
    expect(downloads[0]?.retryBlocked).toBe(false)
    expect(downloads[1]?.retryBlocked).toBe(true)
  })

  it('run:abort aborts the active run signal', async () => {
    downloadImpl = async (opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve(summary('aborted', [])))
      })
    const runner = makeRunner()
    await runner.start(await ready(runner))
    await vi.waitFor(() => expect(downloads).toHaveLength(1))
    runner.abort()
    await runner.idle()
    expect(doneOf()[0]?.status).toBe('aborted')
  })

  it('run status: a snapshot of the progress while running, not running before and after', async () => {
    let release: () => void = () => undefined
    let snapshotInside: unknown = null
    const runner = makeRunner()
    downloadImpl = async (opts) => {
      const e0 = opts.plan.entries[0]!
      opts.onEvent?.({ type: 'file_start', index: 0, entry: e0 })
      opts.onEvent?.({ type: 'bytes', doneBytes: 10, totalBytes: 20 })
      opts.onEvent?.({ type: 'file_done', result: result(e0, 'downloaded') })
      opts.onEvent?.({ type: 'file_start', index: 2, entry: opts.plan.entries[2]! })
      opts.onEvent?.({ type: 'file_done', result: result(opts.plan.entries[2]!, 'skipped') })
      opts.onEvent?.({ type: 'file_start', index: 1, entry: opts.plan.entries[1]! })
      snapshotInside = runner.status()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return summary('complete', [])
    }
    expect(runner.status()).toEqual({ running: false })
    await runner.start(await ready(runner))
    await vi.waitFor(() => expect(snapshotInside).not.toBeNull())
    expect(snapshotInside).toEqual({
      running: true,
      filesDone: 1,
      filesTotal: 2,
      doneBytes: 10,
      totalBytes: 20,
      currentPath: 'Klient/b.mp4',
    })
    expect(runner.status()).toEqual(snapshotInside)
    release()
    await runner.idle()
    expect(runner.status()).toEqual({ running: false })
  })

  it('does not start a run that was aborted while its destination was being checked', async () => {
    let runner: Runner | null = null
    let checks = 0
    runner = makeRunner({
      preflight: async ({ chosenDir: dir, plan }): Promise<Preflight> => {
        checks += 1
        if (checks === 2) runner?.abort()
        return { destRoot: path.join(dir, plan.rootName), state: 'new', lastRunAt: null, freeBytes: 1e12, neededBytes: 20, problem: null, warning: null }
      },
    })
    const scanId = await ready(runner)
    expect((await runner.start(scanId)).ok).toBe(false)
    expect(downloads).toHaveLength(0)
    expect(runner.isRunning()).toBe(false)
    expect(doneOf()).toHaveLength(0)
  })

  it('asks to sign in before starting', async () => {
    let signedIn = true
    const runner = makeRunner({ isSignedIn: async () => signedIn })
    const scanId = await ready(runner)
    signedIn = false
    expect(await runner.start(scanId)).toEqual({ ok: false, error: 'Nejdřív se přihlas přes Google.' })
    expect(downloads).toHaveLength(0)
    expect(blocker.started).toBe(0)
  })
})
