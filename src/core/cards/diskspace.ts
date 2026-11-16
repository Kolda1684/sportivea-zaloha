import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'

const DEFAULT_RESERVE_BYTES = 5 * 1024 ** 3
const DEFAULT_POLL_MS = 30_000
const ASK_MACOS_TIMEOUT_MS = 10_000

/**
 * JXA run by `osascript`; the folder comes in as an argument (never spliced into the script). Prints the bytes
 * available for "important" use on the folder's volume, or ERR.
 */
const IMPORTANT_USAGE_SCRIPT =
  'function run(argv){ObjC.import("Foundation");const out=Ref();' +
  'const ok=$.NSURL.fileURLWithPath(argv[0]).getResourceValueForKeyError(out,$.NSURLVolumeAvailableCapacityForImportantUsageKey,null);' +
  'return ok?String(ObjC.unwrap(out[0])):"ERR"}'

/**
 * Space macOS makes available for a user-requested write on the volume holding `dir`, including purgeable space
 * (Google Drive for desktop's cache of already uploaded files, local snapshots) that macOS frees only when something
 * actually writes. This is what Finder shows. `null` when it cannot be asked (not macOS, missing folder, timeout).
 */
export async function importantUsageBytes(dir: string): Promise<number | null> {
  if (process.platform !== 'darwin') return null
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', IMPORTANT_USAGE_SCRIPT, '--', dir],
      { timeout: ASK_MACOS_TIMEOUT_MS },
      (err, stdout) => {
        const n = Number(String(stdout).trim())
        resolve(err === null && Number.isFinite(n) && n > 0 ? n : null)
      },
    )
  })
}

/** Empty blocks available to unprivileged writers on the volume holding `dir` (excludes purgeable space). */
export async function statfsFreeBytes(dir: string): Promise<number> {
  const s = await fs.statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/**
 * Free space for the card copy on the volume holding `dir`. Uses macOS's important-usage capacity: waiting for
 * empty blocks alone deadlocks, because the purgeable Drive cache is only freed when something writes, and the
 * waiter itself is what stops the writing.
 */
export async function freeBytes(
  dir: string,
  deps: { importantUsage?: (d: string) => Promise<number | null>; statfsFree?: (d: string) => Promise<number> } = {},
): Promise<number> {
  const statfsFree = await (deps.statfsFree ?? statfsFreeBytes)(dir)
  const important = await (deps.importantUsage ?? importantUsageBytes)(dir)
  return important === null ? statfsFree : Math.max(important, statfsFree)
}

/**
 * Returns a function that resolves once `dir`'s volume has `bytes` + reserve free.
 * While waiting it polls every `pollMs` and calls `onWaiting(needed, free)` once per call
 * (needed includes the reserve).
 */
export function makeSpaceWaiter(
  dir: string,
  opts: {
    reserveBytes?: number
    pollMs?: number
    free?: (d: string) => Promise<number>
    onWaiting?: (needed: number, free: number) => void
  } = {},
): (bytes: number) => Promise<void> {
  const reserve = opts.reserveBytes ?? DEFAULT_RESERVE_BYTES
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const free = opts.free ?? ((d: string): Promise<number> => freeBytes(d))
  return async (bytes: number): Promise<void> => {
    const needed = bytes + reserve
    let announced = false
    for (;;) {
      const available = await free(dir)
      if (available >= needed) return
      if (!announced) {
        announced = true
        opts.onWaiting?.(needed, available)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
    }
  }
}
