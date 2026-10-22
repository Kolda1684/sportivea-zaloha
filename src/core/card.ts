import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CardFile } from './types'

const SYSTEM_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  '.Spotlight-V100',
  '.fseventsd',
  '.Trashes',
  '.TemporaryItems',
])

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4',
  'mov',
  'mxf',
  'mts',
  'm2ts',
  'm4v',
  'avi',
])

const CARD_MARKERS: readonly string[] = [
  'PRIVATE/M4ROOT/CLIP',
  'DCIM',
  'PRIVATE/AVCHD',
  'CLIP',
  'XDROOT',
]

function isSystemEntry(name: string): boolean {
  return name.startsWith('._') || SYSTEM_NAMES.has(name)
}

/** Sony proxies (`M4ROOT/SUB/`) and thumbnails (`M4ROOT/THMBNL/`) are kept as plain files, never treated as clips. */
const SIDECAR_DIR = /(^|\/)M4ROOT\/(SUB|THMBNL)\//i

function kindOf(relPath: string, fileName: string): CardFile['kind'] {
  if (SIDECAR_DIR.test(relPath)) return 'other'
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return 'other'
  return VIDEO_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase()) ? 'video' : 'other'
}

/**
 * Lists every regular file on the card (recursively), read-only.
 * System entries are skipped; symlinks and special files are ignored.
 * Errors (e.g. unreadable directory) propagate so that nothing is silently left out.
 */
export async function scanCard(root: string): Promise<CardFile[]> {
  const out: CardFile[] = []

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (isSystemEntry(entry.name)) continue
      const absPath = join(absDir, entry.name)
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(absPath, relPath)
      } else if (entry.isFile()) {
        const info = await lstat(absPath)
        out.push({ relPath, absPath, size: info.size, kind: kindOf(relPath, entry.name) })
      }
    }
  }

  await walk(root, '')
  return out
}

/** True if the volume has the typical folder structure of a camera memory card. */
export async function looksLikeCard(root: string): Promise<boolean> {
  for (const marker of CARD_MARKERS) {
    try {
      if ((await stat(join(root, marker))).isDirectory()) return true
    } catch {
      // marker not present
    }
  }
  return false
}
