import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { caseKey, withSuffix } from './names'
import type { DownloadPlan, PlanEntry } from './types'

/**
 * Filesystem steps of the downloader (`downloader.ts`). Read-only on everything except: `mkdir` of planned folders
 * that do not exist yet. Nothing here writes, renames or removes an existing path.
 */

const posix = path.posix
const HASH_READ_CHUNK = 1024 * 1024
const MAX_SUFFIX = 10_000
const READ_NOFOLLOW = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW

export const FOLDER_IN_WAY = 'v cíli je místo složky soubor nebo odkaz se stejným jménem'
export const NO_FREE_NAME = 'nepodařilo se najít volné jméno souboru'
const folderFailed = (code: string): string => `složku se nepodařilo vytvořit (${code})`

export function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const code = (e as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : undefined
}

/** Thrown inside the downloader to end the whole run with a stop status. */
export class RunStopped extends Error {
  readonly status: 'destination_lost' | 'auth_lost' | 'aborted' | 'journal_error' | 'disk_full'
  constructor(status: RunStopped['status']) {
    super(status)
    this.name = 'RunStopped'
    this.status = status
  }
}

/** `lstat` (symlinks not followed); `null` when nothing is there (ENOENT/ENOTDIR). */
export async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p)
  } catch (e) {
    const code = errCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw e
  }
}

/** True when the chosen directory no longer `lstat`s (disk unplugged, folder moved away). Never recreates it. */
async function destinationGone(chosenDir: string): Promise<boolean> {
  try {
    await fs.lstat(chosenDir)
    return false
  } catch {
    return true
  }
}

export type DirIdentity = { dev: number; ino: number }

/** `dev`/`ino` of `p` (lstat); `null` when it does not lstat. */
export async function dirIdentity(p: string): Promise<DirIdentity | null> {
  try {
    const st = await fs.lstat(p)
    return { dev: st.dev, ino: st.ino }
  } catch {
    return null
  }
}

/** Whether `rel` or one of its ancestors could not be created; returns the Czech reason. */
export function blockedReason(blocked: Map<string, string>, rel: string): string | null {
  for (let dir = rel; dir !== '.' && dir !== '' && dir !== '/'; dir = posix.dirname(dir)) {
    const reason = blocked.get(dir)
    if (reason !== undefined) return reason
  }
  return null
}

/** Non-recursive mkdir; `null` when the folder is (now) a real directory, else the Czech reason. */
async function makeDir(chosenDir: string, rel: string): Promise<string | null> {
  const p = path.join(chosenDir, rel)
  let failure: unknown
  try {
    await fs.mkdir(p)
    return null
  } catch (e) {
    failure = e
  }
  if (errCode(failure) === 'EEXIST') {
    try {
      // Only a real directory is used; a symlink to one is never followed.
      return (await fs.lstat(p)).isDirectory() ? null : FOLDER_IN_WAY
    } catch (e) {
      failure = e
    }
  }
  if (await destinationGone(chosenDir)) throw new RunStopped('destination_lost')
  return folderFailed(errCode(failure) ?? 'neznámá chyba')
}

/**
 * Creates `rootName` and the plan's folders, parents first, with non-recursive `mkdir`. An existing real directory
 * is fine; a symlink or file in the way blocks that folder and everything below it (never followed or removed).
 * Returns the blocked folders (relative path → reason) and the folders that exist as real directories.
 */
export async function createFolders(
  chosenDir: string,
  plan: DownloadPlan,
  signal: AbortSignal | undefined,
): Promise<{ blocked: Map<string, string>; ready: Set<string> }> {
  const blocked = new Map<string, string>()
  const ready = new Set<string>()
  for (const rel of [plan.rootName, ...plan.folders.filter((f) => f !== plan.rootName)]) {
    if (signal?.aborted === true) throw new RunStopped('aborted')
    const inherited = blockedReason(blocked, posix.dirname(rel))
    const reason = inherited ?? (await makeDir(chosenDir, rel))
    if (reason === null) ready.add(rel)
    else blocked.set(rel, reason)
  }
  return { blocked, ready }
}

const nameKey = (name: string): string => caseKey(name.normalize('NFC'))

/** Per folder (relative path), the case-folded names the plan uses there: entries of every kind and subfolders. */
function plannedNames(plan: DownloadPlan): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>()
  const add = (rel: string): void => {
    const dir = posix.dirname(rel)
    const set = names.get(dir) ?? new Set<string>()
    set.add(nameKey(posix.basename(rel)))
    names.set(dir, set)
  }
  for (const e of plan.entries) add(e.localRelPath)
  for (const f of plan.folders) if (f !== plan.rootName) add(f)
  return names
}

/**
 * Names to avoid per folder (relative path → case-folded names): the plan's names, and once a folder is first
 * searched, its directory listing. Each pick is added, so a folder is listed only once per run.
 */
export type NameIndex = { names: Map<string, Set<string>>; listed: Set<string> }

export function nameIndex(plan: DownloadPlan): NameIndex {
  return { names: plannedNames(plan), listed: new Set() }
}

/**
 * Next free ` (n)` variant (n ≥ 2) of `name` in folder `dirRel`: not present on disk (case-insensitive, listing
 * cached from the first search in that folder) and not used by the plan or an earlier pick in this run.
 */
export async function freeName(chosenDir: string, dirRel: string, name: string, index: NameIndex): Promise<string> {
  const taken = index.names.get(dirRel) ?? new Set<string>()
  index.names.set(dirRel, taken)
  if (!index.listed.has(dirRel)) {
    for (const entry of await fs.readdir(path.join(chosenDir, dirRel))) taken.add(nameKey(entry))
    index.listed.add(dirRel)
  }
  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const candidate = withSuffix(name, n)
    const key = nameKey(candidate)
    if (taken.has(key)) continue
    taken.add(key)
    return candidate
  }
  throw new Error(NO_FREE_NAME)
}

/**
 * Ruling 10: whether the existing regular file at `p` (lstat `st`) holds exactly this Drive file (size and MD5).
 * Returns its `mtimeMs` when it does, `null` otherwise. Opens read-only without following a symlink.
 */
export async function matchingFileMtime(
  p: string,
  st: Stats,
  entry: PlanEntry,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  if (entry.kind !== 'file' || entry.md5 === null || entry.size === null || st.size !== entry.size) return null
  const fh = await fs.open(p, READ_NOFOLLOW)
  try {
    const fst = await fh.stat()
    if (!fst.isFile() || fst.ino !== st.ino || fst.size !== entry.size) return null
    const hash = createHash('md5')
    const buf = Buffer.allocUnsafe(HASH_READ_CHUNK)
    for (let pos = 0; pos < fst.size; ) {
      signal?.throwIfAborted()
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, fst.size - pos), pos)
      if (bytesRead === 0) return null
      hash.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    return hash.digest('hex') === entry.md5.toLowerCase() ? fst.mtimeMs : null
  } finally {
    await fh.close()
  }
}
