/**
 * IPC surface shared by main, preload and renderer. This file imports nothing: the renderer project compiles it
 * without Node types. The payload types mirror the core types; main assigns core values to them, so the compiler
 * catches a drift.
 */

/** IPC channel names. `handle` channels are invoked by the renderer; the last three are events sent by main. */
export const IPC = {
  ping: 'download.app:ping',
  authStatus: 'download.auth:status',
  authSignIn: 'download.auth:signIn',
  authSignOut: 'download.auth:signOut',
  driveScan: 'download.drive:scan',
  destPick: 'download.dest:pick',
  runStart: 'download.run:start',
  runAbort: 'download.run:abort',
  runRetryFailed: 'download.run:retryFailed',
  runStatus: 'download.run:status',
  shellShowDest: 'download.shell:showDest',
  driveScanProgress: 'download.drive:scanProgress',
  runEvent: 'download.run:event',
  runDone: 'download.run:done',
} as const

export type AuthStatus = { signedIn: boolean; email: string | null }
export type SignInResult = { ok: true; email: string } | { ok: false; error: string }
/** Signing out is refused (with a Czech reason) while a download runs. */
export type SignOutResult = { ok: true } | { ok: false; error: string }

export type PlanSummary = {
  rootName: string
  /** Files and Google exports to download. */
  fileCount: number
  /** Subfolders below the root folder. */
  folderCount: number
  totalBytes: number
  /** Items that are not downloaded (shortcuts, forms, ...). Files with download disabled count as files: they fail. */
  skipped: number
  /** Files with the same content as another file in the folder: downloaded once, not part of `fileCount`/`totalBytes`. */
  duplicateCount: number
  duplicateBytes: number
}
export type ScanResult = { ok: true; scanId: string; plan: PlanSummary } | { ok: false; error: string }
export type ScanProgress = { files: number; bytes: number }

export type PreflightInfo = {
  destRoot: string
  state: 'new' | 'resume' | 'foreign'
  lastRunAt: string | null
  freeBytes: number
  neededBytes: number
  /** Czech text that blocks Start, or `null`. */
  problem: string | null
  /** Non-blocking Czech hint, or `null`. */
  warning: string | null
}
/** `null` when the folder dialog was cancelled. */
export type DestPickResult = { ok: true; preflight: PreflightInfo } | { ok: false; error: string } | null

export type StartResult = { ok: true } | { ok: false; error: string }

/**
 * Whether a download is running, with the progress so far: a window that loads during a run (reload, reopened
 * window) shows the progress screen instead of the folder choice. Speed and ETA follow from the next events.
 */
export type RunStatusInfo =
  | { running: false }
  | { running: true; filesDone: number; filesTotal: number; doneBytes: number; totalBytes: number; currentPath: string | null }

export type EntryOutcome = 'downloaded' | 'exported' | 'already' | 'changed_copy' | 'duplicate' | 'skipped' | 'failed'
export type RunStatus = 'complete' | 'incomplete' | 'destination_lost' | 'auth_lost' | 'aborted' | 'journal_error' | 'disk_full'

export type PlanEntryInfo = {
  fileId: string
  drivePath: string
  localRelPath: string
  kind: 'file' | 'export' | 'skip'
  size: number | null
  md5: string | null
  mimeType: string
  exportMime: string | null
  modifiedTime: string
  skipReason: string | null
  blocked: boolean
  duplicate: boolean
}

export type EntryResultInfo = {
  entry: PlanEntryInfo
  outcome: EntryOutcome
  localRelPath: string
  md5: string | null
  bytes: number
  reason: string | null
}

/** A downloader event; `bytes` events arrive at most every 250 ms (the last one always arrives). */
export type RunEventPayload =
  | { type: 'file_start'; index: number; entry: PlanEntryInfo }
  | { type: 'bytes'; doneBytes: number; totalBytes: number }
  | { type: 'file_done'; result: EntryResultInfo }

/** End of a run (Ruling 2). `manifestPath` is `null` when the CSV could not be written. */
export type RunDone = {
  status: RunStatus
  counts: Record<EntryOutcome, number>
  downloadedBytes: number
  startedAt: string
  finishedAt: string
  manifestPath: string | null
  failed: { path: string; reason: string }[]
  /** Items not downloaded on purpose (shortcuts, forms, ...), with the reason. */
  skipped: { path: string; reason: string }[]
}

/** Events main sends to the renderer, by channel. */
export type MainEvents = {
  'download.drive:scanProgress': ScanProgress
  'download.run:event': RunEventPayload
  'download.run:done': RunDone
}

/** The only surface the preload script exposes to the renderer as `window.api`. */
export interface DownloadApi {
  ping: () => Promise<'pong'>
  authStatus: () => Promise<AuthStatus>
  signIn: () => Promise<SignInResult>
  signOut: () => Promise<SignOutResult>
  scan: (link: string) => Promise<ScanResult>
  pickDestination: (scanId: string) => Promise<DestPickResult>
  startRun: (scanId: string) => Promise<StartResult>
  abortRun: () => Promise<void>
  retryFailed: () => Promise<StartResult>
  runStatus: () => Promise<RunStatusInfo>
  showDestination: () => Promise<void>
  /** Each `on*` returns a function that removes the listener. */
  onScanProgress: (listener: (progress: ScanProgress) => void) => () => void
  onRunEvent: (listener: (event: RunEventPayload) => void) => () => void
  onRunDone: (listener: (done: RunDone) => void) => () => void
}
