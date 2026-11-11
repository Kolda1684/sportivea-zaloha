import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  RunStopped,
  blockedReason,
  createFolders,
  dirIdentity,
  errCode,
  freeName,
  lstatOrNull,
  matchingFileMtime,
  nameIndex,
} from './download-steps'
import type { DirIdentity, NameIndex } from './download-steps'
import { DriveError } from './drive'
import type { DriveClient } from './drive'
import { JournalFormatError, appendRecord, loadJournal } from './journal'
import type { JournalRecord } from './journal'
import { contentKey } from './scan'
import type { DownloadPlan, PlanEntry } from './types'
import { writeVerified } from './writer'
import type { WriteOptions, WriteResult } from './writer'

/**
 * Sequential downloader: one file at a time, in plan order. On the destination it only adds (folders, files under
 * free names, its own temps and journal lines); an existing file is never modified. A file is reported as
 * downloaded only after it was verified, given its final name and recorded in the journal.
 */

/** `duplicate`: not downloaded, the same content is already on the disk (`reason` names where). */
export type EntryOutcome = 'downloaded' | 'exported' | 'already' | 'changed_copy' | 'duplicate' | 'skipped' | 'failed'

export type EntryResult = {
  entry: PlanEntry
  outcome: EntryOutcome
  /** Where the file is (or would have been) on disk, relative to the chosen directory. */
  localRelPath: string
  md5: string | null
  bytes: number
  reason: string | null
}

export type DownloadEvent =
  | { type: 'file_start'; index: number; entry: PlanEntry }
  /**
   * `doneBytes` = planned bytes of the files processed so far + the most bytes the current file has reached (capped
   * at its planned size). Never goes down, never exceeds `totalBytes`. Exports count 0 (not part of `totalBytes`).
   */
  | { type: 'bytes'; doneBytes: number; totalBytes: number }
  | { type: 'file_done'; result: EntryResult }

export type DownloadSummary = {
  /**
   * `journal_error`: the journal is damaged (not a regular file); the run stops because resume would be impossible.
   * `disk_full`: a write hit ENOSPC/EDQUOT; the run stops (every next file would fail too), the partial stays.
   */
  status: 'complete' | 'incomplete' | 'destination_lost' | 'auth_lost' | 'aborted' | 'journal_error' | 'disk_full'
  results: EntryResult[]
  /**
   * Total size of the files that were verified and got their final name in this run (outcomes `downloaded`,
   * `exported`, `changed_copy`). Bytes resumed from an earlier run's partial are included; `already` counts 0.
   */
  downloadedBytes: number
  startedAt: string
  finishedAt: string
}

export type DownloadOptions = {
  client: Pick<DriveClient, 'download' | 'exportFile'>
  plan: DownloadPlan
  chosenDir: string
  signal?: AbortSignal
  onEvent?: (e: DownloadEvent) => void
  /** Hard-link primitive passed to the writer (tests simulate volumes without hard links, e.g. exFAT). */
  linkFn?: WriteOptions['linkFn']
  /**
   * Ask Drive for entries whose owner disabled downloading (`PlanEntry.blocked`) instead of failing them at once.
   * Set on a retry: the owner may have allowed it since; a refusal fails the entry again with the same reason.
   */
  retryBlocked?: boolean
}

export const CORRUPT = 'soubor se stáhl poškozený'
export const CONNECTION_LOST = 'výpadek spojení, zkus znovu'
export const DOWNLOAD_DISABLED = 'vlastník zakázal stahování'
export const SIZE_ONLY = 'ověřena jen velikost (Google neuvádí MD5)'
export const DUPLICATE_OF = 'stejný obsah jako '
const diskError = (code: string): string => `chyba při zápisu na disk (${code})`

const posix = path.posix
/** FAT/exFAT store local time: after a daylight-saving change a file's mtime reads exactly one hour off. */
const FAT_DST_SHIFT_MS = 3_600_000
const FRESHLY_WRITTEN: ReadonlySet<EntryOutcome> = new Set(['downloaded', 'exported', 'changed_copy'])
/** Outcomes after which the entry's content is on the disk at the result's path. */
const CONTENT_ON_DISK: ReadonlySet<EntryOutcome> = new Set(['downloaded', 'already', 'changed_copy'])
/** No space left on the volume, or the user's quota on it is used up. */
const DISK_FULL_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT'])

type Run = Omit<DownloadOptions, 'signal' | 'onEvent'> & {
  /** The caller's signal combined with the run's own (aborted when `onEvent` throws). */
  signal: AbortSignal
  emit: (e: DownloadEvent) => void
  destRoot: string
  journal: Map<string, JournalRecord>
  blocked: Map<string, string>
  /** Plan folders that exist as real directories. */
  ready: Set<string>
  /** Names that free-name picks must avoid. */
  names: NameIndex
  /** Content key -> where that content is on the disk (relative to the chosen directory), filled as entries finish. */
  content: Map<string, string>
  /** Identity of the chosen directory and of the destination root at the start: a different inode is a lost disk. */
  chosenId: DirIdentity
  rootId: DirIdentity | null
  /** Planned bytes of the `file` entries processed so far. */
  processedBytes: number
  /** High-water mark of the current file's bytes, capped at its planned size. */
  fileBytes: number
}

const toResult = (
  entry: PlanEntry,
  outcome: EntryOutcome,
  localRelPath: string,
  md5: string | null = null,
  bytes = 0,
  reason: string | null = null,
): EntryResult => ({ entry, outcome, localRelPath, md5, bytes, reason })

const sameDir = (now: DirIdentity | null, then: DirIdentity): boolean =>
  now !== null && now.dev === then.dev && now.ino === then.ino

/**
 * The destination is lost when the chosen directory or the destination root no longer lstats or is a different
 * directory than at the start (e.g. an empty stale `/Volumes/X` left after an unclean unplug, a moved-away root).
 */
async function destinationLost(run: Run): Promise<boolean> {
  if (!sameDir(await dirIdentity(run.chosenDir), run.chosenId)) return true
  return run.rootId !== null && !sameDir(await dirIdentity(run.destRoot), run.rootId)
}

/** Maps an error to a stop of the whole run, or to the Czech reason this one entry failed. */
async function classify(run: Run, e: unknown): Promise<{ stop: RunStopped['status'] } | { reason: string }> {
  if (e instanceof RunStopped) return { stop: e.status }
  if (run.signal.aborted) return { stop: 'aborted' }
  if (e instanceof JournalFormatError) return { stop: 'journal_error' }
  if (e instanceof DriveError) {
    if (e.kind === 'auth') return { stop: 'auth_lost' }
    if (e.kind === 'cannot_download' || e.kind === 'not_found' || e.kind === 'forbidden') return { reason: e.message }
    return { reason: CONNECTION_LOST }
  }
  if (await destinationLost(run)) return { stop: 'destination_lost' }
  const code = errCode(e)
  if (code !== undefined && DISK_FULL_CODES.has(code)) return { stop: 'disk_full' }
  if (code !== undefined) return { reason: diskError(code) }
  return { reason: e instanceof Error ? e.message : String(e) }
}

/** The journal record for this entry, if it belongs to this destination root. */
function recordFor(run: Run, entry: PlanEntry): JournalRecord | null {
  const rec = run.journal.get(entry.fileId)
  return rec !== undefined && rec.localRelPath.startsWith(`${run.plan.rootName}/`) ? rec : null
}

function sameVersion(rec: JournalRecord, entry: PlanEntry): boolean {
  if (rec.kind !== entry.kind) return false
  const sameSize = entry.size === null || rec.size === entry.size
  // A file with an MD5 is identified by its content: same MD5 and size is the same version, even when Drive bumped
  // `modifiedTime` (e.g. a metadata edit). Exports and files without MD5 go by `modifiedTime`.
  if (entry.kind === 'file' && entry.md5 !== null) return sameSize && rec.md5?.toLowerCase() === entry.md5.toLowerCase()
  return rec.modifiedTime === entry.modifiedTime && (entry.kind !== 'file' || sameSize)
}

/**
 * Journal says done: the file is still there with the recorded size and mtime (no re-hash; MD5 was verified on
 * write). An mtime exactly one hour off is accepted too (FAT daylight-saving shift).
 */
async function stillOnDisk(run: Run, rec: JournalRecord): Promise<boolean> {
  const st = await lstatOrNull(path.join(run.chosenDir, rec.localRelPath))
  if (st === null || !st.isFile() || st.size !== rec.size) return false
  const shift = Math.abs(st.mtimeMs - rec.localMtimeMs)
  return shift === 0 || shift === FAT_DST_SHIFT_MS
}

async function remember(run: Run, record: JournalRecord): Promise<void> {
  await appendRecord(run.destRoot, record)
  run.journal.set(record.fileId, record)
}

function emitBytes(run: Run): void {
  const done = Math.min(run.processedBytes + run.fileBytes, run.plan.totalBytes)
  run.emit({ type: 'bytes', doneBytes: done, totalBytes: run.plan.totalBytes })
}

async function writeOnce(run: Run, entry: PlanEntry, dir: string, name: string): Promise<WriteResult> {
  const { client, signal } = run
  const { fileId, exportMime } = entry
  if (entry.kind === 'export' && exportMime === null) throw new Error('chybí formát exportu')
  const isFile = entry.kind === 'file'
  return writeVerified({
    dir,
    name,
    fileId,
    expectedMd5: isFile ? entry.md5 : null,
    expectedSize: isFile ? entry.size : null,
    open: (from) => (isFile ? client.download(fileId, from, signal) : client.exportFile(fileId, exportMime ?? '', signal)),
    // Exports are not part of `totalBytes`, so only real files move the byte counter. A restart or a mismatch
    // retry starts `n` from 0 again; the high-water mark keeps the progress from going back.
    onBytes: isFile
      ? (n) => {
          run.fileBytes = Math.min(Math.max(run.fileBytes, n), entry.size ?? 0)
          emitBytes(run)
        }
      : undefined,
    signal,
    linkFn: run.linkFn,
  })
}

/** Downloads into `rel` (a free name), with one fresh retry on a mismatch, then journals it. */
async function download(run: Run, entry: PlanEntry, rel: string, outcome: EntryOutcome): Promise<EntryResult> {
  const dir = path.join(run.chosenDir, posix.dirname(rel))
  const name = posix.basename(rel)
  let written = await writeOnce(run, entry, dir, name)
  // The bad bytes stay as `.<fileId>.bad`; the retry starts from a new partial.
  if (written.status === 'mismatch') written = await writeOnce(run, entry, dir, name)
  if (written.status === 'mismatch') return toResult(entry, 'failed', rel, null, 0, CORRUPT)
  const st = await fs.lstat(written.finalPath)
  await remember(run, {
    fileId: entry.fileId,
    localRelPath: rel,
    size: written.bytes,
    md5: written.md5,
    modifiedTime: entry.modifiedTime,
    kind: entry.kind === 'export' ? 'export' : 'file',
    localMtimeMs: st.mtimeMs,
    at: new Date().toISOString(),
  })
  // Without a Google MD5 the writer could check the size only; the CSV says so.
  const reason = entry.kind === 'file' && entry.md5 === null && entry.size !== null ? SIZE_ONLY : null
  return toResult(entry, outcome, rel, written.md5, written.bytes, reason)
}

/** Downloads to `rel`; a file already there is adopted when identical (Ruling 10), else the next free name is used. */
async function placeAt(run: Run, entry: PlanEntry, rel: string): Promise<EntryResult> {
  const outcome: EntryOutcome = entry.kind === 'export' ? 'exported' : 'downloaded'
  const target = path.join(run.chosenDir, rel)
  const st = await lstatOrNull(target)
  if (st === null) return download(run, entry, rel, outcome)
  const mtimeMs = st.isFile() ? await matchingFileMtime(target, st, entry, run.signal) : null
  if (mtimeMs !== null) {
    await remember(run, {
      fileId: entry.fileId,
      localRelPath: rel,
      size: st.size,
      md5: entry.md5,
      modifiedTime: entry.modifiedTime,
      kind: 'file',
      localMtimeMs: mtimeMs,
      at: new Date().toISOString(),
    })
    return toResult(entry, 'already', rel, entry.md5, st.size)
  }
  const dirRel = posix.dirname(rel)
  return download(run, entry, posix.join(dirRel, await freeName(run.chosenDir, dirRel, posix.basename(rel), run.names)), outcome)
}

/** Decides one non-skip entry: already, changed copy, or a download to the planned (or a free) name. */
async function placeEntry(run: Run, entry: PlanEntry): Promise<EntryResult> {
  const rec = recordFor(run, entry)
  if (entry.blocked && run.retryBlocked !== true) {
    // Download disabled by the owner: no Drive request. A copy verified in an earlier run is still on the disk.
    if (rec !== null && sameVersion(rec, entry) && (await stillOnDisk(run, rec))) {
      return toResult(entry, 'already', rec.localRelPath, rec.md5, rec.size)
    }
    return toResult(entry, 'failed', entry.localRelPath, null, 0, DOWNLOAD_DISABLED)
  }
  if (rec === null) return placeAt(run, entry, entry.localRelPath)
  if (sameVersion(rec, entry)) {
    if (await stillOnDisk(run, rec)) return toResult(entry, 'already', rec.localRelPath, rec.md5, rec.size)
    // Gone or altered locally: back to the journal's path when its folder is still planned, else the planned path.
    const preferred = run.ready.has(posix.dirname(rec.localRelPath)) ? rec.localRelPath : entry.localRelPath
    return placeAt(run, entry, preferred)
  }
  const dirRel = posix.dirname(entry.localRelPath)
  const name = await freeName(run.chosenDir, dirRel, posix.basename(entry.localRelPath), run.names)
  return download(run, entry, posix.join(dirRel, name), 'changed_copy')
}

/** One entry to its result; a stop of the whole run is thrown as `RunStopped`. */
async function processEntry(run: Run, entry: PlanEntry): Promise<EntryResult> {
  if (entry.kind === 'skip') return toResult(entry, 'skipped', entry.localRelPath, null, 0, entry.skipReason)
  // A duplicate whose content is on the disk is not downloaded; when every earlier copy failed, it is downloaded.
  const key = contentKey(entry)
  const copy = entry.duplicate && key !== null ? run.content.get(key) : undefined
  if (copy !== undefined) return toResult(entry, 'duplicate', entry.localRelPath, entry.md5, 0, DUPLICATE_OF + copy)
  const blocked = blockedReason(run.blocked, posix.dirname(entry.localRelPath))
  if (blocked !== null) return toResult(entry, 'failed', entry.localRelPath, null, 0, blocked)
  try {
    return await placeEntry(run, entry)
  } catch (e) {
    const c = await classify(run, e)
    if ('stop' in c) throw new RunStopped(c.stop)
    return toResult(entry, 'failed', entry.localRelPath, null, 0, c.reason)
  }
}

/** Checks the destination, creates the folders, records their identity and loads the journal. */
async function prepare(opts: DownloadOptions, signal: AbortSignal, emit: Run['emit']): Promise<Run> {
  const { client, plan, chosenDir, linkFn, retryBlocked } = opts
  if (signal.aborted) throw new RunStopped('aborted')
  const chosenId = await dirIdentity(chosenDir)
  if (chosenId === null) throw new RunStopped('destination_lost')
  const { blocked, ready } = await createFolders(chosenDir, plan, signal)
  const destRoot = path.join(chosenDir, plan.rootName)
  const rootReady = ready.has(plan.rootName)
  const rootId = rootReady ? await dirIdentity(destRoot) : null
  if (rootReady && rootId === null) throw new RunStopped('destination_lost')
  const run: Run = {
    client,
    plan,
    chosenDir,
    linkFn,
    retryBlocked,
    signal,
    emit,
    destRoot,
    journal: new Map(),
    blocked,
    ready,
    names: nameIndex(plan),
    content: new Map(),
    chosenId,
    rootId,
    processedBytes: 0,
    fileBytes: 0,
  }
  // A root that could not be created is never entered (it may be a symlink): every entry fails as blocked.
  if (!rootReady) return run
  try {
    run.journal = await loadJournal(destRoot)
  } catch (e) {
    const c = await classify(run, e)
    // Without a readable journal there is no resume and no honest "complete".
    throw new RunStopped('stop' in c ? c.stop : 'journal_error')
  }
  return run
}

async function runEntries(
  opts: DownloadOptions,
  signal: AbortSignal,
  emit: Run['emit'],
  results: EntryResult[],
): Promise<DownloadSummary['status']> {
  try {
    const run = await prepare(opts, signal, emit)
    for (const [index, entry] of opts.plan.entries.entries()) {
      if (signal.aborted) return 'aborted'
      if (await destinationLost(run)) return 'destination_lost'
      emit({ type: 'file_start', index, entry })
      if (signal.aborted) return 'aborted'
      run.fileBytes = 0
      const result = await processEntry(run, entry)
      results.push(result)
      const key = contentKey(entry)
      if (key !== null && CONTENT_ON_DISK.has(result.outcome) && !run.content.has(key)) {
        run.content.set(key, result.localRelPath)
      }
      // A skipped duplicate is not part of `totalBytes`; one downloaded in place of a failed copy is counted (capped).
      if (entry.kind === 'file' && result.outcome !== 'duplicate') {
        run.processedBytes += entry.size ?? 0
        run.fileBytes = 0
        emitBytes(run)
      }
      emit({ type: 'file_done', result })
    }
  } catch (e) {
    // Filesystem and Drive errors are classified where they happen; anything else is a bug and propagates.
    if (e instanceof RunStopped) return e.status
    throw e
  }
  return results.some((r) => r.outcome === 'failed') ? 'incomplete' : 'complete'
}

/**
 * Downloads the plan into `chosenDir`. Resolves with the summary; rejects only on a bug or when `onEvent` throws:
 * then the current write is aborted (its partial stays), no later entry is attempted and that error is rethrown,
 * so a broken listener never turns into failed files.
 */
export async function runDownload(opts: DownloadOptions): Promise<DownloadSummary> {
  const startedAt = new Date().toISOString()
  const results: EntryResult[] = []
  const listener = new AbortController()
  const signal = opts.signal === undefined ? listener.signal : AbortSignal.any([opts.signal, listener.signal])
  const listenerFailure: { failed: boolean; error: unknown } = { failed: false, error: undefined }
  const emit = (e: DownloadEvent): void => {
    if (listenerFailure.failed) return
    try {
      opts.onEvent?.(e)
    } catch (error) {
      listenerFailure.failed = true
      listenerFailure.error = error
      listener.abort(new Error('onEvent threw; run stopped'))
    }
  }

  const status = await runEntries(opts, signal, emit, results)
  if (listenerFailure.failed) throw listenerFailure.error
  return {
    status,
    results,
    downloadedBytes: results.reduce((sum, r) => sum + (FRESHLY_WRITTEN.has(r.outcome) ? r.bytes : 0), 0),
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}
