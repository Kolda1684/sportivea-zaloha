import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { JournalFormatError, journalPath, loadJournal, type JournalRecord } from './journal'
import { caseKey } from './names'
import type { DownloadPlan } from './types'

const execFileAsync = promisify(execFile)

export type Preflight = {
  destRoot: string
  state: 'new' | 'resume' | 'foreign'
  lastRunAt: string | null
  freeBytes: number
  neededBytes: number
  /** Czech text that blocks Start, or `null`. */
  problem: string | null
  /** Non-blocking Czech hint (e.g. filesystem type unknown while a file exceeds the FAT32 limit), or `null`. */
  warning: string | null
}

type StatfsResult = { bavail: number; bsize: number; type: string }
type StatfsFn = (p: string) => Promise<StatfsResult>

const FAT_MAX_FILE_BYTES = 4_294_967_295
const BYTES_PER_TENTH_GB = 1e8
const MOUNT_TIMEOUT_MS = 5000

const FAT32_PROBLEM =
  'Disk je naformátovaný jako FAT32 a neunese soubory větší než 4 GB. Použij disk ve formátu exFAT nebo APFS.'
const CLOUD_PROBLEM = 'Vyber externí disk, ne složku Google Disku.'
const READ_ONLY_PROBLEM = 'Na tento disk nejde zapisovat. Zkontroluj, že není zamčený nebo jen pro čtení.'
const NTFS_PROBLEM =
  'Na tento disk nejde zapisovat. Je ve formátu NTFS (z Windows), do kterého Mac neumí zapisovat. Použij disk ve formátu exFAT nebo APFS.'
const DAMAGED_JOURNAL_DIR_PROBLEM = 'Ve složce je poškozený záznam o stahování (.stahovani). Vyber jiné místo.'
const UNKNOWN_FS_WARNING = 'Nepodařilo se zjistit formát disku. Pokud je to FAT32, soubory nad 4 GB se nestáhnou.'
const UNKNOWN_FS_TYPE = 'unknown'
const UNREADABLE_DISK_PROBLEM = 'Vybraný disk se nepodařilo přečíst. Zkontroluj, že je připojený.'
const PREVIOUS_TARGET_WARNING =
  'Vybraná složka vypadá jako cíl dřívějšího stahování. Pro navázání vyber složku o úroveň výš.'
const MAC_DISK_WARNING = 'Cíl je na disku Macu, ne na externím disku.'
/** The Mac's own disk. On macOS 10.15+ user data lives on the Data volume, which `/` may not report as its device. */
const DEFAULT_SYSTEM_ROOTS = ['/', '/System/Volumes/Data']

/** Decimal GB rounded UP to one decimal with a Czech comma, so a shortfall is never understated. */
export function formatGb(bytes: number): string {
  const tenths = Math.ceil(bytes / BYTES_PER_TENTH_GB)
  return `${Math.floor(tenths / 10)},${tenths % 10}`
}

/**
 * Filesystem type of the volume holding `dir`, read from `mount` output: the longest mount point that
 * prefixes `dir` wins. Lines look like `/dev/disk4s1 on /Volumes/X (msdos, local, nodev)`.
 */
export function fsTypeFromMount(dir: string, mountOutput: string): string | null {
  let best: { mountPoint: string; type: string } | null = null
  for (const line of mountOutput.split('\n')) {
    const optionsAt = line.lastIndexOf(' (')
    if (optionsAt < 0 || !line.endsWith(')')) continue
    const onAt = line.indexOf(' on ')
    if (onAt < 0 || onAt >= optionsAt) continue
    const mountPoint = line.slice(onAt + 4, optionsAt)
    const type = line.slice(optionsAt + 2, -1).split(',')[0]?.trim().toLowerCase()
    if (!type || !mountPoint.startsWith('/')) continue
    const prefix = mountPoint === '/' ? '/' : `${mountPoint}/`
    if (dir !== mountPoint && !dir.startsWith(prefix)) continue
    if (best === null || mountPoint.length > best.mountPoint.length) best = { mountPoint, type }
  }
  return best?.type ?? null
}

const runMount = async (): Promise<string> =>
  (await execFileAsync('/sbin/mount', [], { timeout: MOUNT_TIMEOUT_MS })).stdout

/**
 * Free space from `fs.statfs`. On macOS `statfs.type` is only a number that does not identify FAT, so the type
 * name (msdos / exfat / apfs / hfs) is read from `/sbin/mount`. Fails closed: if that cannot be determined the
 * type is `'unknown'` (never the numeric type), and preflight warns when it matters.
 */
export function makeStatfs(mount: () => Promise<string>): StatfsFn {
  return async (p) => {
    const s = await fs.statfs(p)
    let type = UNKNOWN_FS_TYPE
    try {
      type = fsTypeFromMount(await fs.realpath(p), await mount()) ?? UNKNOWN_FS_TYPE
    } catch {
      // mount unavailable (or not macOS): stay 'unknown'
    }
    return { bavail: Number(s.bavail), bsize: Number(s.bsize), type }
  }
}

export const defaultStatfs: StatfsFn = makeStatfs(runMount)

async function canWrite(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

async function isInsideCloudStorage(dir: string): Promise<boolean> {
  const marker = '/library/cloudstorage/'
  const candidates = [path.resolve(dir)]
  try {
    candidates.push(await fs.realpath(dir))
  } catch {
    // directory missing: the plain path is all we have
  }
  return candidates.some((c) => `${c.toLowerCase()}/`.includes(marker))
}

async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(p)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
}

const nameKey = (name: string): string => caseKey(name.normalize('NFC'))

/**
 * The user picked the destination root of an earlier run instead of its parent: the folder has a journal of its
 * own, or it has the root folder's name. Starting there would nest a second copy inside the first.
 */
async function looksLikePreviousTarget(chosenDir: string, rootName: string): Promise<boolean> {
  if (nameKey(path.basename(chosenDir)) === nameKey(rootName)) return true
  try {
    return (await lstatOrNull(journalPath(chosenDir))) !== null
  } catch {
    return false
  }
}

/** Whether `chosenDir` is on the same volume as one of `systemRoots` (stat `dev`). Unreadable paths never match. */
async function onSystemDisk(chosenDir: string, systemRoots: readonly string[]): Promise<boolean> {
  let dev: number
  try {
    dev = (await fs.stat(chosenDir)).dev
  } catch {
    return false
  }
  for (const root of systemRoots) {
    try {
      if ((await fs.stat(root)).dev === dev) return true
    } catch {
      // not there (older macOS, other OS): skip
    }
  }
  return false
}

/** Whether the existing `destRoot` holds anything besides `.DS_Store` and an empty `.stahovani` directory. */
async function hasForeignContent(destRoot: string): Promise<boolean> {
  for (const name of await fs.readdir(destRoot)) {
    if (name === '.DS_Store') continue
    if (name === '.stahovani') {
      const inner = await fs.readdir(path.join(destRoot, name)).catch(() => null)
      if (inner !== null && inner.length === 0) continue
    }
    return true
  }
  return false
}

export async function preflight(opts: {
  chosenDir: string
  plan: DownloadPlan
  statfs?: StatfsFn
  /** Paths on the Mac's own disk; a destination on the same volume gets a warning. Tests pass `[]`. */
  systemRoots?: readonly string[]
  /** Whether `chosenDir` accepts writes; default `access(W_OK)` (EROFS on read-only mounts such as NTFS). */
  writable?: (dir: string) => Promise<boolean>
}): Promise<Preflight> {
  const { chosenDir, plan } = opts
  const statfs = opts.statfs ?? defaultStatfs
  const destRoot = path.join(chosenDir, plan.rootName)

  let state: Preflight['state'] = 'new'
  let lastRunAt: string | null = null
  let done = new Map<string, JournalRecord>()
  let destProblem: string | null = null

  try {
    const rootStat = await lstatOrNull(destRoot)
    if (rootStat !== null) {
      const stateDir = await lstatOrNull(path.join(destRoot, '.stahovani'))
      if (!rootStat.isDirectory()) {
        state = 'foreign'
        destProblem = `V cílovém umístění už existuje „${plan.rootName}“, ale není to složka.`
      } else if (stateDir !== null && !stateDir.isDirectory()) {
        state = 'foreign'
        destProblem = DAMAGED_JOURNAL_DIR_PROBLEM
      } else if ((await lstatOrNull(journalPath(destRoot))) !== null) {
        state = 'resume'
        done = await loadJournal(destRoot)
        for (const r of done.values()) {
          const t = Date.parse(r.at)
          if (!Number.isNaN(t) && (lastRunAt === null || t > Date.parse(lastRunAt))) lastRunAt = r.at
        }
      } else if (await hasForeignContent(destRoot)) {
        state = 'foreign'
      }
    }
  } catch (err) {
    done = new Map()
    lastRunAt = null
    state = 'foreign'
    destProblem = err instanceof JournalFormatError ? err.message : UNREADABLE_DISK_PROBLEM
  }

  let neededBytes = 0
  let hasFatOversize = false
  for (const e of plan.entries) {
    if (e.kind !== 'file' || e.size === null) continue
    if (e.size > FAT_MAX_FILE_BYTES) hasFatOversize = true
    if (done.get(e.fileId)?.size === e.size) continue
    neededBytes += e.size
  }

  let freeBytes = 0
  let type = ''
  let unreadable = false
  try {
    const s = await statfs(chosenDir)
    freeBytes = s.bavail * s.bsize
    type = s.type
  } catch {
    unreadable = true
  }

  const writable = await (opts.writable ?? canWrite)(chosenDir)

  let problem: string | null = null
  if (await isInsideCloudStorage(chosenDir)) problem = CLOUD_PROBLEM
  else if (destProblem !== null) problem = destProblem
  else if (unreadable) problem = UNREADABLE_DISK_PROBLEM
  else if (!writable) problem = /ntfs/i.test(type) ? NTFS_PROBLEM : READ_ONLY_PROBLEM
  else if (hasFatOversize && /msdos|fat32/i.test(type)) problem = FAT32_PROBLEM
  else if (neededBytes > freeBytes) problem = `Na disku chybí ${formatGb(neededBytes - freeBytes)} GB.`

  // Non-blocking hints, joined into one text.
  const warnings: string[] = []
  if (type.toLowerCase() === UNKNOWN_FS_TYPE && hasFatOversize) warnings.push(UNKNOWN_FS_WARNING)
  if (await looksLikePreviousTarget(chosenDir, plan.rootName)) warnings.push(PREVIOUS_TARGET_WARNING)
  if (await onSystemDisk(chosenDir, opts.systemRoots ?? DEFAULT_SYSTEM_ROOTS)) warnings.push(MAC_DISK_WARNING)
  const warning = warnings.length > 0 ? warnings.join(' ') : null

  return { destRoot, state, lastRunAt, freeBytes, neededBytes, problem, warning }
}
