/**
 * In-process fake of the Google Drive v3 REST API (the subset the app uses), for tests only.
 * Runs a real `node:http` server on 127.0.0.1 so the client's `fetch` path is exercised end to end.
 *
 * Typical use:
 *   const drive = await FakeDrive.start()
 *   const ids = drive.addTree(null, { Zapas: { 'a.mp4': Buffer.from('abc'), sub: { 'b.txt': 'hi' } } })
 *   const client = new DriveClient({ tokens, baseUrl: drive.baseUrl })
 *   ...
 *   await drive.close()
 *
 * Features:
 *  - tree builder: addFolder / addFile / addGoogleDoc / addTree / addFiles; removeItem
 *  - changing a file between runs: updateFile(id, { bytes, md5, modifiedTime })
 *  - per-path failure scripting: scriptFailures(match, steps)
 *  - token control: acceptTokens / rejectAllTokens
 *  - request log: `requests` (method, path, query, headers, status)
 *  - concurrency counter for downloads: activeDownloads / maxConcurrentDownloads
 *  - Range support (`ignoreRange` makes the server answer 200 with the full body instead)
 *  - pagination: `maxPageSize` caps the page size the client asked for; `pageSizes` serves empty/short pages
 *  - shared drives: items with `sharedDrive: true` need `supportsAllDrives=true` (+ `includeItemsFromAllDrives=true` for lists)
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const API_PREFIX = '/drive/v3'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const DOC_MIME = 'application/vnd.google-apps.document'

export type RequestLogEntry = {
  method: string
  /** Pathname as received, e.g. `/drive/v3/files/<id>` (see `FakeDrive.filePath`). */
  path: string
  /** Query string as a plain object (last value wins). */
  query: Record<string, string>
  headers: IncomingHttpHeaders
  /** `req.url` verbatim (path + query), for asserting that nothing secret is in the URL. */
  rawUrl: string
  /** Status that was sent; `null` when the connection was dropped or no response was sent yet. */
  status: number | null
}

/**
 * One scripted reaction to one matching request. Steps of one script are consumed one per request;
 * when the script is used up, the server goes back to normal behaviour.
 *  - `{ status, ... }`: answer with this HTTP status. By default the body is Google-style error JSON
 *    built from `reason` and `message`; `body` replaces it with a raw string (use it for non-JSON bodies).
 *  - `{ kind: 'drop' }`: destroy the connection before any response header (client sees a network error).
 *  - `{ kind: 'cut', afterBytes }`: send the normal response header and `afterBytes` bytes of the body,
 *    then destroy the connection (client sees a stream error after headers).
 *  - `{ kind: 'pass' }`: handle this request normally (e.g. 503, 503, pass).
 */
export type FailStep =
  | { status: number; reason?: string; message?: string; body?: string; headers?: Record<string, string> }
  | { kind: 'drop' }
  | { kind: 'cut'; afterBytes: number }
  | { kind: 'pass' }

/**
 * Which requests a script applies to. A string is an exact pathname (use `FakeDrive.filePath`),
 * a RegExp is tested against the pathname, a function gets the log entry (e.g. to tell `alt=media` apart).
 */
export type RequestMatch = string | RegExp | ((entry: RequestLogEntry) => boolean)

export type AddFileOptions = {
  id?: string
  mimeType?: string
  createdTime?: string
  modifiedTime?: string
  /** Value of `capabilities.canDownload` (default true). */
  canDownload?: boolean
  /** Report this md5Checksum instead of the real one. */
  md5?: string
  /**
   * The item lives in a shared drive: like the real API, the fake answers 404 for it (and leaves it out of
   * listings) unless the request carries `supportsAllDrives=true` (and, for listings, `includeItemsFromAllDrives=true`).
   */
  sharedDrive?: boolean
}

export type AddFolderOptions = Pick<AddFileOptions, 'id' | 'createdTime' | 'modifiedTime' | 'sharedDrive'>

export type FileChanges = {
  bytes?: Buffer | string
  /** Pins the reported md5Checksum. Without it the md5 follows the bytes. */
  md5?: string
  modifiedTime?: string
  /** Changes `capabilities.canDownload` (the owner allows or forbids downloading). */
  canDownload?: boolean
}

/** Nested spec for `addTree`: string/Buffer = file with that content, object = folder. */
export type TreeSpec = { [name: string]: string | Buffer | TreeSpec }

type Item = {
  id: string
  name: string
  mimeType: string
  parentId: string | null
  createdTime: string
  modifiedTime: string
  canDownload: boolean
  /** Folders and Google-native documents have no bytes. */
  bytes: Buffer | null
  md5Override: string | null
  /** Google-native documents: export mime -> content. */
  exports: Map<string, Buffer> | null
  sharedDrive: boolean
}

type Script = { match: RequestMatch; steps: FailStep[] }

const md5Of = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex')
const toBuffer = (c: Buffer | string): Buffer => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c)

export class FakeDrive {
  /** Base URL to pass to `DriveClient` (`http://127.0.0.1:<port>/drive/v3`). */
  readonly baseUrl: string
  /** Every request received, in order. `clearLog()` empties it. */
  readonly requests: RequestLogEntry[] = []
  /** Answer Range requests with 200 and the full body (a misbehaving server). Default false. */
  ignoreRange = false
  /** Upper bound for the page size, whatever the client asks for. Default 1000 (the real API limit). */
  maxPageSize = 1000
  /**
   * Page sizes served for successive pages of a listing, cycling (0 = an empty page). Every page that is not
   * the last carries a fresh `nextPageToken`, also the empty ones, as the real API may do. null = off.
   */
  pageSizes: number[] | null = null
  /** Download bodies are written in chunks of this many bytes (default: whole body at once)... */
  chunkSize: number | null = null
  /** ...with this pause between chunks; with `chunkSize` null the pause is before the whole body. */
  chunkDelayMs = 0
  /** Downloads and exports currently being served. */
  activeDownloads = 0
  /** Highest value `activeDownloads` reached since start or the last `resetConcurrency()`. */
  maxConcurrentDownloads = 0

  private readonly server: Server
  private readonly items = new Map<string, Item>()
  private readonly scripts: Script[] = []
  private accepted = new Set<string>(['test-token'])
  private rejectAll = false
  private counter = 0

  private constructor(server: Server, port: number) {
    this.server = server
    this.baseUrl = `http://127.0.0.1:${port}${API_PREFIX}`
  }

  static async start(): Promise<FakeDrive> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const drive = new FakeDrive(server, (server.address() as AddressInfo).port)
    server.on('request', (req, res) => {
      drive.handle(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500
        res.destroy()
      })
    })
    return drive
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** Pathname of a files endpoint, for `scriptFailures` and for asserting on the log. */
  filePath(id: string, suffix?: 'export'): string {
    return `${API_PREFIX}/files/${id}${suffix ? `/${suffix}` : ''}`
  }

  // ---- tree builder ----

  /** Adds a folder; `parentId` null/omitted = top level (reachable by id only, like a shared folder). */
  addFolder(name: string, parentId: string | null = null, options: AddFolderOptions = {}): string {
    return this.insert({ name, parentId, mimeType: FOLDER_MIME, bytes: null, exports: null }, options)
  }

  addFile(parentId: string | null, name: string, content: Buffer | string, options: AddFileOptions = {}): string {
    return this.insert(
      { name, parentId, mimeType: options.mimeType ?? 'application/octet-stream', bytes: toBuffer(content), exports: null },
      options,
    )
  }

  /** A Google-native document: no size/md5, cannot be downloaded, can be exported to the given mime types. */
  addGoogleDoc(
    parentId: string | null,
    name: string,
    exports: Record<string, Buffer | string>,
    options: AddFileOptions = {},
  ): string {
    const map = new Map(Object.entries(exports).map(([mime, c]) => [mime, toBuffer(c)] as const))
    return this.insert(
      { name, parentId, mimeType: options.mimeType ?? DOC_MIME, bytes: null, exports: map },
      options,
    )
  }

  /** Builds a nested tree under `parentId`. Returns slash-joined relative path -> item id for every node. */
  addTree(parentId: string | null, spec: TreeSpec, prefix = ''): Map<string, string> {
    const ids = new Map<string, string>()
    for (const [name, value] of Object.entries(spec)) {
      const path = `${prefix}${name}`
      if (typeof value === 'string' || Buffer.isBuffer(value)) {
        ids.set(path, this.addFile(parentId, name, value))
      } else {
        const folderId = this.addFolder(name, parentId)
        ids.set(path, folderId)
        for (const [p, id] of this.addTree(folderId, value, `${path}/`)) ids.set(p, id)
      }
    }
    return ids
  }

  /** Adds `count` small files `file-00001.txt`, ... to a folder (for pagination tests). Returns their ids. */
  addFiles(parentId: string | null, count: number): string[] {
    const ids: string[] = []
    for (let i = 1; i <= count; i += 1) {
      const name = `file-${String(i).padStart(5, '0')}.txt`
      ids.push(this.addFile(parentId, name, `content ${i}`))
    }
    return ids
  }

  /** Removes an item (later requests for it answer 404, it disappears from its parent's listing). */
  removeItem(id: string): void {
    this.items.delete(id)
  }

  /** Changes a file between runs. Bytes alone change the md5 too; `modifiedTime` is NOT bumped automatically. */
  updateFile(id: string, changes: FileChanges): void {
    const item = this.mustGet(id)
    if (changes.bytes !== undefined) item.bytes = toBuffer(changes.bytes)
    if (changes.md5 !== undefined) item.md5Override = changes.md5
    if (changes.modifiedTime !== undefined) item.modifiedTime = changes.modifiedTime
    if (changes.canDownload !== undefined) item.canDownload = changes.canDownload
  }

  // ---- failures ----

  /** Queues steps for requests matching `match` (see `FailStep`). Several scripts can coexist; first match wins. */
  scriptFailures(match: RequestMatch, steps: FailStep[]): void {
    this.scripts.push({ match, steps: [...steps] })
  }

  clearFailures(): void {
    this.scripts.length = 0
  }

  // ---- tokens ----

  /** Replaces the accepted set (default `['test-token']`) and lifts a previous `rejectAllTokens()`. */
  acceptTokens(...tokens: string[]): void {
    this.accepted = new Set(tokens)
    this.rejectAll = false
  }

  /** From now on every request answers 401, whatever token it carries. */
  rejectAllTokens(): void {
    this.rejectAll = true
  }

  // ---- log / stats ----

  clearLog(): void {
    this.requests.length = 0
  }

  resetConcurrency(): void {
    this.maxConcurrentDownloads = this.activeDownloads
  }

  // ---- internals ----

  private insert(
    base: Pick<Item, 'name' | 'parentId' | 'mimeType' | 'bytes' | 'exports'>,
    options: AddFileOptions,
  ): string {
    this.counter += 1
    const id = options.id ?? `fakeid${String(this.counter).padStart(8, '0')}`
    if (this.items.has(id)) throw new Error(`FakeDrive: duplicate id ${id}`)
    this.items.set(id, {
      ...base,
      id,
      createdTime: options.createdTime ?? '2026-01-01T10:00:00.000Z',
      modifiedTime: options.modifiedTime ?? '2026-01-02T10:00:00.000Z',
      canDownload: options.canDownload ?? true,
      md5Override: options.md5 ?? null,
      sharedDrive: options.sharedDrive ?? false,
    })
    return id
  }

  private mustGet(id: string): Item {
    const item = this.items.get(id)
    if (!item) throw new Error(`FakeDrive: unknown id ${id}`)
    return item
  }

  private toResource(item: Item): Record<string, unknown> {
    const resource: Record<string, unknown> = {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      createdTime: item.createdTime,
      modifiedTime: item.modifiedTime,
      capabilities: { canDownload: item.canDownload },
    }
    if (item.bytes) {
      resource['size'] = String(item.bytes.length)
      resource['md5Checksum'] = item.md5Override ?? md5Of(item.bytes)
    }
    return resource
  }

  private matches(match: RequestMatch, entry: RequestLogEntry): boolean {
    if (typeof match === 'string') return entry.path === match
    if (match instanceof RegExp) return match.test(entry.path)
    return match(entry)
  }

  private nextStep(entry: RequestLogEntry): FailStep | null {
    for (let i = 0; i < this.scripts.length; i += 1) {
      const script = this.scripts[i]
      if (!script || !this.matches(script.match, entry)) continue
      const step = script.steps.shift()
      if (script.steps.length === 0) this.scripts.splice(i, 1)
      if (step) return step
    }
    return null
  }

  private sendJson(
    res: ServerResponse,
    entry: RequestLogEntry,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    this.sendRaw(res, entry, status, JSON.stringify(body), { 'content-type': 'application/json; charset=UTF-8', ...headers })
  }

  private sendRaw(
    res: ServerResponse,
    entry: RequestLogEntry,
    status: number,
    body: string | Buffer,
    headers: Record<string, string> = {},
  ): void {
    entry.status = status
    res.writeHead(status, { 'content-length': String(Buffer.byteLength(body)), ...headers })
    res.end(body)
  }

  private sendError(
    res: ServerResponse,
    entry: RequestLogEntry,
    status: number,
    reason: string,
    message: string,
    headers: Record<string, string> = {},
  ): void {
    this.sendJson(
      res,
      entry,
      status,
      { error: { code: status, message, errors: [{ message, domain: 'global', reason }] } },
      headers,
    )
  }

  private authorized(header: string | undefined): boolean {
    if (this.rejectAll || !header) return false
    const match = /^Bearer (.+)$/.exec(header)
    return match !== null && this.accepted.has(match[1] ?? '')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake')
    const entry: RequestLogEntry = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      rawUrl: req.url ?? '',
      status: null,
    }
    this.requests.push(entry)

    if (entry.method !== 'GET') {
      this.sendError(res, entry, 405, 'methodNotAllowed', 'Method not allowed')
      return
    }
    if (!this.authorized(req.headers.authorization)) {
      this.sendError(res, entry, 401, 'authError', 'Invalid Credentials')
      return
    }

    let cutAfter: number | null = null
    const step = this.nextStep(entry)
    if (step) {
      if ('kind' in step) {
        if (step.kind === 'drop') {
          res.destroy()
          return
        }
        if (step.kind === 'cut') cutAfter = step.afterBytes
      } else {
        if (step.body !== undefined) {
          this.sendRaw(res, entry, step.status, step.body, step.headers)
        } else {
          this.sendError(res, entry, step.status, step.reason ?? 'backendError', step.message ?? 'Scripted failure', step.headers)
        }
        return
      }
    }

    if (!entry.path.startsWith(`${API_PREFIX}/files`)) {
      this.sendError(res, entry, 404, 'notFound', 'Not found')
      return
    }
    const rest = entry.path.slice(`${API_PREFIX}/files`.length)
    if (rest === '') {
      this.handleList(res, entry)
      return
    }
    const parts = rest.split('/').filter((p) => p !== '')
    const id = parts[0] ? decodeURIComponent(parts[0]) : ''
    const item = this.items.get(id)
    if (!item || (item.sharedDrive && entry.query['supportsAllDrives'] !== 'true')) {
      this.sendError(res, entry, 404, 'notFound', `File not found: ${id}.`)
      return
    }
    if (parts.length === 1) {
      if (entry.query['alt'] === 'media') await this.handleMedia(req, res, entry, item, cutAfter)
      else this.sendJson(res, entry, 200, this.toResource(item))
      return
    }
    if (parts.length === 2 && parts[1] === 'export') {
      await this.handleExport(res, entry, item, cutAfter)
      return
    }
    this.sendError(res, entry, 404, 'notFound', 'Not found')
  }

  private handleList(res: ServerResponse, entry: RequestLogEntry): void {
    const q = /^'((?:[^'\\]|\\.)*)' in parents and trashed=false$/.exec(entry.query['q'] ?? '')
    if (!q) {
      this.sendError(res, entry, 400, 'invalid', 'Invalid Value')
      return
    }
    const parentId = (q[1] ?? '').replace(/\\(.)/g, '$1')
    const allDrives = entry.query['supportsAllDrives'] === 'true' && entry.query['includeItemsFromAllDrives'] === 'true'
    const children = [...this.items.values()].filter((i) => i.parentId === parentId && (allDrives || !i.sharedDrive))
    const requested = Number(entry.query['pageSize'] ?? '100')
    let pageSize = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 100, this.maxPageSize))
    // token = "<offset>.<page number>": unique per page even when a page is empty
    const [offsetText = '0', pageText = '0'] = (entry.query['pageToken'] ?? '').split('.')
    const offset = Number(offsetText) || 0
    const pageNumber = Number(pageText) || 0
    if (this.pageSizes && this.pageSizes.length > 0) {
      pageSize = Math.min(pageSize, this.pageSizes[pageNumber % this.pageSizes.length] ?? pageSize)
    }
    const page = children.slice(offset, offset + pageSize)
    const body: Record<string, unknown> = { kind: 'drive#fileList', files: page.map((i) => this.toResource(i)) }
    if (offset + pageSize < children.length) body['nextPageToken'] = `${offset + pageSize}.${pageNumber + 1}`
    this.sendJson(res, entry, 200, body)
  }

  private async handleMedia(
    req: IncomingMessage,
    res: ServerResponse,
    entry: RequestLogEntry,
    item: Item,
    cutAfter: number | null,
  ): Promise<void> {
    if (!item.bytes) {
      this.sendError(res, entry, 403, 'fileNotDownloadable', 'Only files with binary content can be downloaded.')
      return
    }
    if (!item.canDownload) {
      this.sendError(res, entry, 403, 'cannotDownloadFile', 'The user does not have sufficient permissions for this file.')
      return
    }
    const total = item.bytes.length
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (range && !this.ignoreRange) {
      const start = Number(range[1])
      const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
      if (start >= total) {
        this.sendError(res, entry, 416, 'requestedRangeNotSatisfiable', 'Requested range not satisfiable', {
          'content-range': `bytes */${total}`,
        })
        return
      }
      await this.streamBody(res, entry, 206, item.bytes.subarray(start, end + 1), cutAfter, {
        'content-range': `bytes ${start}-${end}/${total}`,
      })
      return
    }
    await this.streamBody(res, entry, 200, item.bytes, cutAfter)
  }

  private async handleExport(res: ServerResponse, entry: RequestLogEntry, item: Item, cutAfter: number | null): Promise<void> {
    if (!item.exports) {
      this.sendError(res, entry, 403, 'fileNotExportable', 'Export only supports Docs Editors files.')
      return
    }
    const content = item.exports.get(entry.query['mimeType'] ?? '')
    if (!content) {
      this.sendError(res, entry, 400, 'invalidMimeType', 'Export format not supported.')
      return
    }
    await this.streamBody(res, entry, 200, content, cutAfter)
  }

  /** Writes a download body, tracking the concurrency counter for as long as the response is open. */
  private async streamBody(
    res: ServerResponse,
    entry: RequestLogEntry,
    status: number,
    body: Buffer,
    cutAfter: number | null,
    headers: Record<string, string> = {},
  ): Promise<void> {
    this.activeDownloads += 1
    this.maxConcurrentDownloads = Math.max(this.maxConcurrentDownloads, this.activeDownloads)
    let closed = false
    res.once('close', () => {
      if (!closed) {
        closed = true
        this.activeDownloads -= 1
      }
    })
    // A pause between chunks ends when the client goes away, so a huge delay never keeps a timer alive.
    const waitUnlessClosed = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          res.off('close', done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        res.once('close', done)
      })
    entry.status = status
    res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': String(body.length), ...headers })
    res.flushHeaders()
    const limit = cutAfter === null ? body.length : Math.min(cutAfter, body.length)
    const step = this.chunkSize ?? Math.max(limit, 1)
    if (this.chunkSize === null && this.chunkDelayMs > 0) await waitUnlessClosed(this.chunkDelayMs)
    for (let pos = 0; pos < limit; pos += step) {
      if (res.destroyed) return
      if (this.chunkSize !== null && pos > 0 && this.chunkDelayMs > 0) await waitUnlessClosed(this.chunkDelayMs)
      const ok = res.write(body.subarray(pos, Math.min(pos + step, limit)))
      if (!ok && !res.destroyed) await new Promise<void>((resolve) => res.once('drain', () => resolve()).once('close', () => resolve()))
    }
    if (cutAfter !== null && cutAfter < body.length) {
      res.destroy()
      return
    }
    res.end()
  }
}
