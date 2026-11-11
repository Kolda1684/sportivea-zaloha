export type DriveItem = {
  id: string
  name: string
  mimeType: string
  size: number | null
  md5: string | null
  createdTime: string
  modifiedTime: string
  canDownload: boolean
}

export type EntryKind = 'file' | 'export' | 'skip'

export type PlanEntry = {
  fileId: string
  drivePath: string
  /** Relative to the chosen directory; starts with `rootName/`. */
  localRelPath: string
  kind: EntryKind
  size: number | null
  md5: string | null
  mimeType: string
  exportMime: string | null
  modifiedTime: string
  skipReason: string | null
  /**
   * The owner disabled downloading (`canDownload: false`). The entry keeps its kind (`file`/`export`) and counts as
   * a planned file; the downloader reports it as failed without asking Drive, except on a retry.
   */
  blocked: boolean
  /**
   * Same content (Google MD5 and size) as an earlier `file` entry in plan order. Not downloaded when that content is
   * already on the disk; downloaded instead when every earlier copy failed. Not part of `fileCount`/`totalBytes`.
   */
  duplicate: boolean
}

export type DownloadPlan = {
  rootName: string
  entries: PlanEntry[]
  /** Local directories to create, relative to the chosen directory; `rootName` first, parents before children. */
  folders: string[]
  /** Files to download (duplicates excluded) and their total size. */
  totalBytes: number
  fileCount: number
  /** Entries marked `duplicate` and their total size. */
  duplicateCount: number
  duplicateBytes: number
}
