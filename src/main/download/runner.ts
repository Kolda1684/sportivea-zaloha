import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { errCode } from '../../core/download/download-steps'
import { runDownload, type DownloadEvent, type DownloadOptions, type DownloadSummary } from '../../core/download/downloader'
import { DriveError, parseFolderLink, type DriveClient } from '../../core/download/drive'
import { writeManifest } from '../../core/download/manifest'
import { preflight, type Preflight } from '../../core/download/preflight'
import { NOT_A_FOLDER, scanFolder } from '../../core/download/scan'
import type { DownloadPlan } from '../../core/download/types'
import {
  IPC,
  type DestPickResult,
  type EntryOutcome,
  type MainEvents,
  type PlanSummary,
  type RunDone,
  type RunStatusInfo,
  type ScanResult,
  type StartResult,
} from '../../shared/download-ipc'
import { isRealDirectory } from './guards'

/**
 * Owns what the renderer must not hold: the scanned plans (by `scanId`), the destination picked in the native
 * dialog, and the one active run. The renderer only ever passes a `scanId`.
 */

const BYTES_INTERVAL_MS = 250

const NOT_A_LINK = 'Tohle není odkaz na složku Google Disku.'
const NOT_SIGNED_IN = 'Nejdřív se přihlas přes Google.'
const SCAN_UNKNOWN = 'Složka už není načtená. Načti ji znovu.'
const NO_DESTINATION = 'Nejdřív vyber cíl na externím disku.'
const BUSY = 'Stahování už běží.'
const NOTHING_TO_RETRY = 'Zatím není co opakovat.'
const SCAN_ABORTED = 'Načítání bylo přerušeno.'
const SCAN_AUTH = 'Přihlášení vypršelo. Přihlas se znovu.'
const SCAN_OFFLINE = 'Nepodařilo se spojit s Google Diskem. Zkontroluj internet a zkus to znovu.'
const SCAN_RATE_LIMIT = 'Google teď omezuje počet požadavků. Zkus to za chvíli.'
const SCAN_FORBIDDEN = 'K téhle složce nemáš přístup.'
const SCAN_FAILED = 'Složku se nepodařilo načíst. Zkus to znovu.'
const DEST_FAILED = 'Cíl se nepodařilo zkontrolovat. Zkus ho vybrat znovu.'
const START_FAILED = 'Stahování se nepodařilo spustit. Zkus to znovu.'
const RUN_CRASHED = 'Stahování se nečekaně zastavilo. Zkus Pokračovat.'
const START_ABORTED = 'Stahování bylo zastaveno.'

export type RunClient = Pick<DriveClient, 'getItem' | 'listChildren' | 'download' | 'exportFile'>

export type RunnerDeps = {
  /** Sends an event to the window. May throw (window closed); the runner swallows that. */
  send: <K extends keyof MainEvents>(channel: K, payload: MainEvents[K]) => void
  powerSaveBlocker: { start(type: 'prevent-app-suspension'): number; stop(id: number): unknown }
  /** A Drive client with the signed-in user's tokens. */
  makeClient: () => RunClient
  isSignedIn: () => Promise<boolean>
  scan?: typeof scanFolder
  download?: (opts: DownloadOptions) => Promise<DownloadSummary>
  preflight?: (opts: { chosenDir: string; plan: DownloadPlan }) => Promise<Preflight>
  writeManifest?: (destRoot: string, summary: DownloadSummary) => Promise<string>
  log?: (message: string) => void
  now?: () => number
  newId?: () => string
}

type Session = { plan: DownloadPlan; chosenDir: string | null }
type Snapshot = Extract<RunStatusInfo, { running: true }>
type LastRun = { plan: DownloadPlan; chosenDir: string; destRoot: string }

const zeroCounts = (): Record<EntryOutcome, number> => ({
  downloaded: 0,
  exported: 0,
  already: 0,
  changed_copy: 0,
  duplicate: 0,
  skipped: 0,
  failed: 0,
})

function summarize(plan: DownloadPlan): PlanSummary {
  return {
    rootName: plan.rootName,
    fileCount: plan.fileCount,
    folderCount: Math.max(0, plan.folders.length - 1),
    totalBytes: plan.totalBytes,
    skipped: plan.entries.filter((e) => e.kind === 'skip').length,
    duplicateCount: plan.duplicateCount,
    duplicateBytes: plan.duplicateBytes,
  }
}

function scanError(e: unknown, aborted: boolean): string {
  if (aborted) return SCAN_ABORTED
  if (e instanceof DriveError) {
    switch (e.kind) {
      case 'auth':
        return SCAN_AUTH
      case 'network':
      case 'server':
        return SCAN_OFFLINE
      case 'rate_limit':
        return SCAN_RATE_LIMIT
      case 'forbidden':
        return SCAN_FORBIDDEN
      case 'not_found':
      case 'cannot_download':
        return e.message
    }
  }
  if (e instanceof Error && e.message === NOT_A_FOLDER) return NOT_A_FOLDER
  return SCAN_FAILED
}

function errorName(e: unknown): string {
  return errCode(e) ?? (e instanceof Error ? e.name : typeof e)
}

const listOf = (summary: DownloadSummary, outcome: EntryOutcome): { path: string; reason: string }[] =>
  summary.results.flatMap((r) => (r.outcome === outcome ? [{ path: r.entry.drivePath, reason: r.reason ?? '' }] : []))

function toRunDone(summary: DownloadSummary, manifestPath: string | null): RunDone {
  const counts = zeroCounts()
  for (const r of summary.results) counts[r.outcome] += 1
  return {
    status: summary.status,
    counts,
    downloadedBytes: summary.downloadedBytes,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    manifestPath,
    failed: listOf(summary, 'failed'),
    skipped: listOf(summary, 'skipped'),
  }
}

/** Forwards downloader events to the window; `bytes` at most every 250 ms, the latest one is never lost. Never throws. */
class EventForwarder {
  private lastBytesAt = Number.NEGATIVE_INFINITY
  private pending: DownloadEvent | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly send: (e: DownloadEvent) => void,
    private readonly now: () => number,
  ) {}

  event(e: DownloadEvent): void {
    try {
      if (e.type !== 'bytes') {
        // A held-back bytes event of file N must reach the window before file_done N / file_start N+1.
        this.flush()
        this.send(e)
        return
      }
      const elapsed = this.now() - this.lastBytesAt
      if (elapsed >= BYTES_INTERVAL_MS) {
        this.pending = null
        this.clearTimer()
        this.sendBytes(e)
        return
      }
      this.pending = e
      // A stall (e.g. a retry backoff) must not hide the latest progress until the next event.
      this.timer ??= setTimeout(() => {
        this.timer = null
        this.flush()
      }, BYTES_INTERVAL_MS - elapsed)
    } catch {
      // Forwarding is best effort: the run must never stop because of the window.
    }
  }

  /** Sends the held-back `bytes` event, if any. */
  flush(): void {
    this.clearTimer()
    const e = this.pending
    this.pending = null
    if (e !== null) this.sendBytes(e)
  }

  private sendBytes(e: DownloadEvent): void {
    this.lastBytesAt = this.now()
    this.send(e)
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

export class Runner {
  private readonly deps: RunnerDeps
  private readonly log: (message: string) => void
  private readonly now: () => number
  /** Only the latest scan is kept (a plan of a large folder is big); `lastRun` keeps its own plan. */
  private scans = new Map<string, Session>()
  private scanController: AbortController | null = null
  private active: AbortController | null = null
  private lastRun: LastRun | null = null
  private running: Promise<void> = Promise.resolve()
  /** Progress of the run in progress (from its events); `null` when no run is downloading. */
  private snapshot: Snapshot | null = null

  constructor(deps: RunnerDeps) {
    this.deps = deps
    this.log = deps.log ?? ((m) => console.log(`[runner] ${m}`))
    this.now = deps.now ?? Date.now
  }

  hasScan(scanId: string): boolean {
    return this.scans.has(scanId)
  }

  /** Scans a Drive folder link. A new scan stops a scan still in progress. Never throws. */
  async scan(link: string): Promise<ScanResult> {
    const folderId = parseFolderLink(link)
    if (folderId === null) return { ok: false, error: NOT_A_LINK }
    this.scanController?.abort()
    const controller = new AbortController()
    this.scanController = controller
    try {
      if (!(await this.deps.isSignedIn())) return { ok: false, error: NOT_SIGNED_IN }
      const scan = this.deps.scan ?? scanFolder
      const plan = await scan(
        this.deps.makeClient(),
        folderId,
        (p) => this.safeSend(IPC.driveScanProgress, { files: p.files, bytes: p.bytes }),
        controller.signal,
      )
      controller.signal.throwIfAborted()
      const scanId = (this.deps.newId ?? randomUUID)()
      this.scans = new Map([[scanId, { plan, chosenDir: null }]])
      return { ok: true, scanId, plan: summarize(plan) }
    } catch (e) {
      if (!controller.signal.aborted) this.log(`scan failed (${e instanceof DriveError ? `DriveError ${e.kind}` : errorName(e)})`)
      return { ok: false, error: scanError(e, controller.signal.aborted) }
    } finally {
      if (this.scanController === controller) this.scanController = null
    }
  }

  /** Remembers the directory picked in the native dialog for this scan and returns its preflight. Never throws. */
  async setDestination(scanId: string, chosenDir: string): Promise<Exclude<DestPickResult, null>> {
    const session = this.scans.get(scanId)
    if (session === undefined) return { ok: false, error: SCAN_UNKNOWN }
    try {
      const dir = path.resolve(chosenDir)
      const pf = await this.checkDestination(dir, session.plan)
      session.chosenDir = dir
      return { ok: true, preflight: pf }
    } catch (e) {
      this.log(`preflight failed (${errorName(e)})`)
      return { ok: false, error: DEST_FAILED }
    }
  }

  /** Starts the download of a scanned plan into its picked destination. Never throws. */
  async start(scanId: string): Promise<StartResult> {
    if (this.active !== null) return { ok: false, error: BUSY }
    const session = this.scans.get(scanId)
    if (session === undefined) return { ok: false, error: SCAN_UNKNOWN }
    if (session.chosenDir === null) return { ok: false, error: NO_DESTINATION }
    return this.begin(session.plan, session.chosenDir, false)
  }

  /**
   * Runs the last run's plan into the same destination again; the journal skips what is already done. Files whose
   * owner disabled downloading are asked for again (the owner may have allowed it since).
   */
  async retryFailed(): Promise<StartResult> {
    if (this.active !== null) return { ok: false, error: BUSY }
    if (this.lastRun === null) return { ok: false, error: NOTHING_TO_RETRY }
    return this.begin(this.lastRun.plan, this.lastRun.chosenDir, true)
  }

  /** A run is starting or in progress. */
  isRunning(): boolean {
    return this.active !== null
  }

  abort(): void {
    this.active?.abort()
  }

  /** Whether a run is downloading, with its progress so far. */
  status(): RunStatusInfo {
    return this.snapshot === null ? { running: false } : { ...this.snapshot }
  }

  /** Destination root of the current or last run (for "Otevřít ve Finderu"), or `null`. */
  destRootToShow(): string | null {
    return this.lastRun?.destRoot ?? null
  }

  /** Resolves when the current run (if any) has finished and `run:done` was sent. */
  idle(): Promise<void> {
    return this.running
  }

  private async begin(plan: DownloadPlan, chosenDir: string, retryBlocked: boolean): Promise<StartResult> {
    // Reserved synchronously, so a double click cannot start two runs.
    const controller = new AbortController()
    this.active = controller
    let started = false
    try {
      if (!(await this.deps.isSignedIn())) return { ok: false, error: NOT_SIGNED_IN }
      // The disk may have changed since it was picked (unplugged, filled up): check again.
      const pf = await this.checkDestination(chosenDir, plan)
      if (pf.problem !== null) return { ok: false, error: pf.problem }
      // Stopped before it began (e.g. the app is closing): nothing to run, nothing to wait for.
      if (controller.signal.aborted) return { ok: false, error: START_ABORTED }
      this.lastRun = { plan, chosenDir, destRoot: pf.destRoot }
      this.running = this.execute(plan, chosenDir, pf.destRoot, controller, retryBlocked)
      started = true
      return { ok: true }
    } catch (e) {
      this.log(`start failed (${errorName(e)})`)
      return { ok: false, error: START_FAILED }
    } finally {
      if (!started && this.active === controller) this.active = null
    }
  }

  private checkDestination(chosenDir: string, plan: DownloadPlan): Promise<Preflight> {
    return (this.deps.preflight ?? preflight)({ chosenDir, plan })
  }

  private async execute(
    plan: DownloadPlan,
    chosenDir: string,
    destRoot: string,
    controller: AbortController,
    retryBlocked: boolean,
  ): Promise<void> {
    let done: RunDone
    this.snapshot = { running: true, filesDone: 0, filesTotal: plan.fileCount, doneBytes: 0, totalBytes: plan.totalBytes, currentPath: null }
    try {
      done = await this.perform(plan, chosenDir, destRoot, controller.signal, retryBlocked)
    } catch (e) {
      // perform() catches everything; this is a last line of defence.
      this.log(`run failed (${errorName(e)})`)
      done = this.crashed(plan)
    } finally {
      this.snapshot = null
      if (this.active === controller) this.active = null
    }
    this.safeSend(IPC.runDone, done)
  }

  private async perform(
    plan: DownloadPlan,
    chosenDir: string,
    destRoot: string,
    signal: AbortSignal,
    retryBlocked: boolean,
  ): Promise<RunDone> {
    const forwarder = new EventForwarder((e) => this.safeSend(IPC.runEvent, e), this.now)
    let blocker: number | null = null
    try {
      blocker = this.deps.powerSaveBlocker.start('prevent-app-suspension')
      let summary: DownloadSummary
      try {
        const download = this.deps.download ?? runDownload
        summary = await download({
          client: this.deps.makeClient(),
          plan,
          chosenDir,
          signal,
          retryBlocked,
          onEvent: (e) => {
            this.track(e)
            forwarder.event(e)
          },
        })
      } catch (e) {
        // runDownload rejects only on a bug (our onEvent never throws).
        this.log(`download failed (${errorName(e)})`)
        return this.crashed(plan)
      } finally {
        forwarder.flush()
      }
      return toRunDone(summary, await this.manifest(destRoot, summary))
    } finally {
      if (blocker !== null) {
        try {
          this.deps.powerSaveBlocker.stop(blocker)
        } catch (e) {
          this.log(`power save blocker not stopped (${errorName(e)})`)
        }
      }
    }
  }

  /** Folds an event into the snapshot (same counting as the progress screen: skipped items and duplicates are not files). */
  private track(e: DownloadEvent): void {
    const s = this.snapshot
    if (s === null) return
    if (e.type === 'file_start') s.currentPath = e.entry.drivePath
    else if (e.type === 'bytes') {
      s.doneBytes = e.doneBytes
      s.totalBytes = e.totalBytes
    } else if (e.result.outcome !== 'skipped' && e.result.outcome !== 'duplicate') s.filesDone += 1
  }

  /** Writes the CSV when the destination root (still) is a real directory; a failure only costs the CSV. */
  private async manifest(destRoot: string, summary: DownloadSummary): Promise<string | null> {
    if (!(await isRealDirectory(destRoot))) return null
    try {
      return await (this.deps.writeManifest ?? writeManifest)(destRoot, summary)
    } catch (e) {
      // Only the error code: the message would contain the path.
      this.log(`manifest not written (${errorName(e)})`)
      return null
    }
  }

  private crashed(plan: DownloadPlan): RunDone {
    const at = new Date().toISOString()
    return {
      status: 'incomplete',
      counts: zeroCounts(),
      downloadedBytes: 0,
      startedAt: at,
      finishedAt: at,
      manifestPath: null,
      failed: [{ path: plan.rootName, reason: RUN_CRASHED }],
      skipped: [],
    }
  }

  private safeSend<K extends keyof MainEvents>(channel: K, payload: MainEvents[K]): void {
    try {
      this.deps.send(channel, payload)
    } catch {
      // The window may be closed or reloading; the run goes on.
    }
  }
}
