import { DriveError } from './drive'
import type { DriveClient } from './drive'
import { assignLocalNames, classifyMime, sanitizeName } from './names'
import type { DownloadPlan, DriveItem, PlanEntry } from './types'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const ROOT_NOT_FOUND = 'Složku se nepodařilo najít. Zkontroluj odkaz a že k ní máš přístup.'
export const NOT_A_FOLDER = 'Odkaz nevede na složku.'
const REPEATED_FOLDER = 'složka se opakuje (nestahuje se)'

type ScanClient = Pick<DriveClient, 'getItem' | 'listChildren'>
type Progress = { files: number; bytes: number }
type QueuedFolder = { id: string; drivePath: string; localRelPath: string }

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Identifies a `file` entry by content (Google MD5 and size); `null` when Drive gives no MD5 or size. */
export function contentKey(entry: PlanEntry): string | null {
  if (entry.kind !== 'file' || entry.md5 === null || entry.size === null) return null
  return `${entry.md5.toLowerCase()}:${entry.size}`
}

/** Marks every `file` entry whose content an earlier entry already has; returns how many and their bytes. */
function markDuplicates(entries: PlanEntry[]): { count: number; bytes: number } {
  const seen = new Set<string>()
  const marked = { count: 0, bytes: 0 }
  for (const entry of entries) {
    const key = contentKey(entry)
    if (key === null) continue
    if (!seen.has(key)) {
      seen.add(key)
      continue
    }
    entry.duplicate = true
    marked.count += 1
    marked.bytes += entry.size ?? 0
  }
  return marked
}

/** What a non-folder child becomes in the plan, and the name that takes part in the folder's namespace. */
function classify(child: DriveItem): {
  kind: PlanEntry['kind']
  exportMime: string | null
  skipReason: string | null
  blocked: boolean
  nameForLocal: string
} {
  const c = classifyMime(child.mimeType)
  // Append the export extension only when the name does not already end with it (case-insensitive).
  const extension = c.extension
  const hasExtension = extension !== null && child.name.toLowerCase().endsWith(extension.toLowerCase())
  const nameForLocal = extension === null || hasExtension ? child.name : child.name + extension
  // Download disabled by the owner: still a planned file (it fails in the downloader), never a silent skip.
  const blocked = c.kind !== 'skip' && !child.canDownload
  return { kind: c.kind, exportMime: c.exportMime, skipReason: c.skipReason, blocked, nameForLocal }
}

/**
 * Walks the folder breadth-first and returns what to download. Nothing on Drive is changed.
 * Paths in the plan are relative to the directory the user chooses and start with the sanitized root name.
 * Entries are ordered by folder (breadth-first), then by local name. A file whose content (MD5 and size) an earlier
 * entry already has is marked `duplicate` and left out of `fileCount`/`totalBytes`.
 */
export async function scanFolder(
  client: ScanClient,
  folderId: string,
  onProgress?: (found: Progress) => void,
  signal?: AbortSignal,
): Promise<DownloadPlan> {
  let root: DriveItem
  try {
    root = await client.getItem(folderId, signal)
  } catch (error) {
    if (error instanceof DriveError && error.kind === 'not_found') {
      throw new DriveError('not_found', ROOT_NOT_FOUND, error.status, { cause: error })
    }
    throw error
  }
  if (root.mimeType !== FOLDER_MIME) throw new Error(NOT_A_FOLDER)

  const rootName = sanitizeName(root.name)
  const entries: PlanEntry[] = []
  const folders: string[] = [rootName]
  const found: Progress = { files: 0, bytes: 0 }
  // Defensive: a real Drive folder has one parent, but a folder id must never be listed twice.
  // A folder id seen again is recorded as a skipped entry, never dropped silently.
  const seen = new Set<string>([folderId, root.id])
  const queue: QueuedFolder[] = [{ id: root.id, drivePath: root.name, localRelPath: rootName }]

  for (let next = 0; next < queue.length; next += 1) {
    signal?.throwIfAborted()
    const folder = queue[next]
    if (!folder) break
    const listed = await client.listChildren(folder.id, signal)

    // Every child is kept: a folder id that was already seen becomes a skipped entry (never listed again).
    // `key` identifies a child in the namespace; a repeated id gets a distinct key.
    const keyCount = new Map<string, number>()
    const planned = listed.map((child) => {
      const count = keyCount.get(child.id) ?? 0
      keyCount.set(child.id, count + 1)
      const key = count === 0 ? child.id : `${child.id}\u0000${count}`
      const isFolder = child.mimeType === FOLDER_MIME
      const repeated = isFolder && seen.has(child.id)
      if (isFolder) seen.add(child.id)
      const info = isFolder ? null : classify(child)
      return { child, key, isFolder, repeated, info }
    })
    // Files, exports, skipped items and subfolders share one namespace, with the final names (exports with extension).
    const localNames = assignLocalNames(
      planned.map(({ child, key, info }) => ({
        id: key,
        name: info ? info.nameForLocal : child.name,
        createdTime: child.createdTime,
      })),
    )
    const nameOf = (key: string): string => localNames.get(key) ?? ''
    planned.sort((a, b) => compare(nameOf(a.key), nameOf(b.key)))

    for (const { child, key, isFolder, repeated, info } of planned) {
      const localRelPath = `${folder.localRelPath}/${nameOf(key)}`
      const drivePath = `${folder.drivePath}/${child.name}`
      if (isFolder && repeated) {
        entries.push({
          fileId: child.id,
          drivePath,
          localRelPath,
          kind: 'skip',
          size: null,
          md5: null,
          mimeType: child.mimeType,
          exportMime: null,
          modifiedTime: child.modifiedTime,
          skipReason: REPEATED_FOLDER,
          blocked: false,
          duplicate: false,
        })
        continue
      }
      if (isFolder || !info) {
        folders.push(localRelPath)
        queue.push({ id: child.id, drivePath, localRelPath })
        continue
      }
      entries.push({
        fileId: child.id,
        drivePath,
        localRelPath,
        kind: info.kind,
        size: child.size,
        md5: child.md5,
        mimeType: child.mimeType,
        exportMime: info.exportMime,
        modifiedTime: child.modifiedTime,
        skipReason: info.skipReason,
        blocked: info.blocked,
        duplicate: false,
      })
      if (info.kind === 'file') {
        found.files += 1
        found.bytes += child.size ?? 0
      } else if (info.kind === 'export') {
        found.files += 1
      }
    }
    onProgress?.({ files: found.files, bytes: found.bytes })
  }

  const duplicates = markDuplicates(entries)
  return {
    rootName,
    entries,
    folders,
    totalBytes: found.bytes - duplicates.bytes,
    fileCount: found.files - duplicates.count,
    duplicateCount: duplicates.count,
    duplicateBytes: duplicates.bytes,
  }
}
