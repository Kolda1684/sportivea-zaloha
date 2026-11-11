import { z } from 'zod'
import type { DriveItem } from './types'

const DEFAULT_BASE_URL = 'https://www.googleapis.com/drive/v3'
const DEFAULT_MAX_RETRIES = 6
const BACKOFF_START_MS = 1000
const BACKOFF_MAX_MS = 32_000
const PAGE_SIZE = 1000
const ITEM_FIELDS = 'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,capabilities/canDownload'

const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/

/**
 * Extracts a folder id from a Drive folder link or a bare id; `null` when the input is none of those.
 * Accepts `drive.google.com/drive/folders/<id>` (also with `/u/<n>/`, query, trailing slash),
 * `drive.google.com/open?id=<id>` and the bare id itself.
 */
export function parseFolderLink(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  if (ID_PATTERN.test(text)) return text
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') return null
  const folder = /^(?:\/u\/\d+)?\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)
  if (folder?.[1] && ID_PATTERN.test(folder[1])) return folder[1]
  if (url.pathname === '/open') {
    const id = url.searchParams.get('id')
    if (id !== null && ID_PATTERN.test(id)) return id
  }
  return null
}

/**
 * Supplies access tokens. Error contract (the client relies on it):
 *  - throw `DriveError('network')` for transient failures (no connection, timeout, 5xx from the token endpoint):
 *    the client retries with its normal backoff, counting toward `maxRetries`;
 *  - throw `DriveError('auth')` only when the grant is invalid or revoked (e.g. `invalid_grant`): the client stops at once;
 *  - any other thrown error is treated as `auth`.
 * Both calls receive the request's `AbortSignal` and should stop work when it aborts. The client does not depend
 * on that: it races each call against the signal, and an abort always surfaces as the abort, never as `auth`.
 */
export type TokenProvider = {
  getAccessToken(signal?: AbortSignal): Promise<string>
  /** Forces a new access token (the current one was rejected) and returns it. */
  refresh(signal?: AbortSignal): Promise<string>
}

export type DriveErrorKind = 'auth' | 'not_found' | 'forbidden' | 'cannot_download' | 'rate_limit' | 'server' | 'network'

/** Messages are Czech: they end up in the list of failed files shown to the user. */
export class DriveError extends Error {
  readonly kind: DriveErrorKind
  readonly status: number | null

  constructor(kind: DriveErrorKind, message: string, status: number | null = null, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DriveError'
    this.kind = kind
    this.status = status
  }
}

const CANNOT_DOWNLOAD_MESSAGES: Record<string, string> = {
  cannotDownloadFile: 'vlastník zakázal stahování',
  cannotDownloadAbusiveFile: 'Google soubor označil jako nebezpečný',
  exportSizeLimitExceeded: 'soubor je příliš velký na export z Google Dokumentů',
  downloadQuotaExceeded: 'Google dočasně omezil stahování tohoto souboru, zkus to později',
}
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded'])

const ErrorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
})

const FileResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.string().optional(),
  md5Checksum: z.string().optional(),
  createdTime: z.string(),
  modifiedTime: z.string(),
  capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
})
const FileListSchema = z.object({
  nextPageToken: z.string().optional(),
  files: z.array(FileResourceSchema),
})

type ErrorInfo = { reasons: string[]; message: string | null }

function toDriveItem(file: z.infer<typeof FileResourceSchema>): DriveItem {
  let size: number | null = null
  if (file.size !== undefined) {
    size = Number(file.size)
    if (!/^\d+$/.test(file.size) || !Number.isSafeInteger(size)) {
      throw new DriveError('server', `Google Disk poslal neplatnou velikost souboru „${file.name}“`)
    }
  }
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size,
    md5: file.md5Checksum ?? null,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    // Absent means "not stated": assume downloadable. A wrong `true` only fails at download time
    // (reported as cannot_download), a wrong `false` would silently skip a file.
    canDownload: file.capabilities?.canDownload ?? true,
  }
}

function parseErrorBody(text: string | null): ErrorInfo {
  if (text === null) return { reasons: [], message: null }
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(text))
    if (!parsed.success) return { reasons: [], message: null }
    const reasons = (parsed.data.error.errors ?? []).flatMap((e) => (e.reason ? [e.reason] : []))
    return { reasons, message: parsed.data.error.message ?? null }
  } catch {
    return { reasons: [], message: null }
  }
}

/** Failure of one HTTP exchange that is worth retrying (after the backoff) or reporting once retries run out. */
type Transient = { kind: 'rate_limit' | 'server' | 'network'; status: number | null; cause?: unknown }

function transientError(t: Transient): DriveError {
  switch (t.kind) {
    case 'rate_limit':
      return new DriveError('rate_limit', 'Google omezuje počet požadavků, zkuste to později', t.status)
    case 'server':
      return new DriveError('server', `Google Disk teď neodpovídá (HTTP ${t.status ?? '?'})`, t.status)
    case 'network':
      return new DriveError('network', 'výpadek připojení k internetu', null, { cause: t.cause })
  }
}

/** Runs `start` and settles with it, or rejects with the signal's reason as soon as the signal aborts. */
async function abortable<T>(start: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return start()
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([start(), aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Sleeps `ms`; an abort of `signal` ends the sleep early (rejecting with the signal's reason) and clears the timer. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Read-only client for the Google Drive v3 REST API. Only ever issues GET; the token goes only in the header. */
export class DriveClient {
  private readonly tokens: TokenProvider
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly maxRetries: number

  constructor(opts: {
    tokens: TokenProvider
    baseUrl?: string
    fetchFn?: typeof fetch
    /** Backoff pause; gets the request's signal so a real timer can be cleared on abort (the client also races it). */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    maxRetries?: number
  }) {
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError(`maxRetries must be a finite integer >= 0, got ${maxRetries}`)
    }
    this.tokens = opts.tokens
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init))
    this.sleep = opts.sleep ?? defaultSleep
    this.maxRetries = maxRetries
  }

  async getItem(id: string, signal?: AbortSignal): Promise<DriveItem> {
    const text = await this.requestText(`/files/${encodeURIComponent(id)}`, { fields: ITEM_FIELDS }, signal)
    return toDriveItem(this.parseJson(text, FileResourceSchema))
  }

  async listChildren(folderId: string, signal?: AbortSignal): Promise<DriveItem[]> {
    const q = `'${folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed=false`
    const items: DriveItem[] = []
    const seenTokens = new Set<string>()
    let pageToken: string | undefined
    do {
      const params: Record<string, string> = {
        q,
        includeItemsFromAllDrives: 'true',
        pageSize: String(PAGE_SIZE),
        fields: `nextPageToken,files(${ITEM_FIELDS})`,
      }
      if (pageToken !== undefined) params['pageToken'] = pageToken
      const page = this.parseJson(await this.requestText('/files', params, signal), FileListSchema)
      for (const file of page.files) items.push(toDriveItem(file))
      // An empty token means "no more pages". Empty or short pages that still carry a token are legal, but a
      // token that comes back would loop forever.
      pageToken = page.nextPageToken === '' ? undefined : page.nextPageToken
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) throw new DriveError('server', 'Google Disk opakuje stejnou stránku seznamu souborů')
        seenTokens.add(pageToken)
      }
    } while (pageToken !== undefined)
    return items
  }

  /**
   * Streams the bytes of a file from `fromByte` on. With `fromByte > 0` the server must answer 206 for exactly
   * that offset; anything else is a `server` error so the caller restarts from 0.
   * An error of the stream after the headers is not handled here: it surfaces when the caller reads the stream.
   */
  async download(fileId: string, fromByte: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0) throw new RangeError(`Invalid start offset: ${fromByte}`)
    const headers: Record<string, string> = fromByte > 0 ? { Range: `bytes=${fromByte}-` } : {}
    const res = await this.request(`/files/${encodeURIComponent(fileId)}`, { alt: 'media' }, headers, signal)
    const problem = this.checkRangeAnswer(res, fromByte)
    if (problem !== null) {
      await res.body?.cancel().catch(() => undefined)
      throw new DriveError('server', problem, res.status)
    }
    return this.bodyOf(res)
  }

  async exportFile(fileId: string, mime: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.request(`/files/${encodeURIComponent(fileId)}/export`, { mimeType: mime }, {}, signal)
    return this.bodyOf(res)
  }

  private checkRangeAnswer(res: Response, fromByte: number): string | null {
    if (fromByte === 0) return null
    if (res.status !== 206) return 'Google Disk ignoroval žádost o pokračování stahování'
    const range = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')
    if (range?.[1] !== String(fromByte)) return 'Google Disk poslal jinou část souboru, než jsme chtěli'
    return null
  }

  private bodyOf(res: Response): ReadableStream<Uint8Array> {
    if (res.body === null) throw new DriveError('server', 'Google Disk poslal prázdnou odpověď', res.status)
    return res.body
  }

  private parseJson<T>(text: string, schema: z.ZodType<T>): T {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (cause) {
      throw new DriveError('server', 'Google Disk poslal nečitelnou odpověď', null, { cause })
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new DriveError('server', 'Google Disk poslal neočekávanou odpověď', null, { cause: parsed.error })
    return parsed.data
  }

  /** GET that returns the whole body text; a body that breaks off midway is a network error and is retried. */
  private requestText(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<string> {
    return this.execute(path, params, {}, signal, (res) => res.text())
  }

  /** GET that returns the response with its body stream untouched. */
  private request(path: string, params: Record<string, string>, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    return this.execute(path, params, headers, signal, (res) => Promise.resolve(res))
  }

  private async execute<T>(
    path: string,
    params: Record<string, string>,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    consume: (res: Response) => Promise<T>,
  ): Promise<T> {
    const query = new URLSearchParams({ supportsAllDrives: 'true', ...params })
    const url = `${this.baseUrl}${path}?${query.toString()}`
    let refreshedOnce = false
    let refreshPending = false

    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted()

      // A pending refresh survives a transient failure of the refresh itself: it is retried, not replaced by the stale token.
      const got = refreshPending
        ? await this.acquire((sig) => this.tokens.refresh(sig), signal)
        : await this.acquire((sig) => this.tokens.getAccessToken(sig), signal)
      let transient: Transient
      if (typeof got !== 'string') {
        transient = got
      } else {
        refreshPending = false
        try {
          const res = await this.fetchFn(url, { method: 'GET', headers: { ...headers, Authorization: `Bearer ${got}` }, signal })
          if (res.ok) return await consume(res)

          const info = parseErrorBody(await res.text().catch(() => null))
          // An abort during the body read must not be mapped to a status error.
          signal?.throwIfAborted()
          if (res.status === 401) {
            if (refreshedOnce) throw new DriveError('auth', 'přihlášení ke Google Disku vypršelo', 401)
            refreshedOnce = true
            refreshPending = true
            attempt -= 1 // the refresh is not a retry: it does not use up the backoff budget
            continue
          }
          transient = this.classify(res.status, info)
        } catch (error) {
          if (signal?.aborted) throw signal.reason
          if (error instanceof DriveError) throw error
          transient = { kind: 'network', status: null, cause: error }
        }
      }

      if (attempt >= this.maxRetries) throw transientError(transient)
      await this.pause(Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS), signal)
    }
  }

  /** Backoff pause that ends at once, rejecting with the signal's reason, when the signal aborts. */
  private pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return abortable(() => this.sleep(ms, signal), signal)
  }

  /** Maps an error status to a retryable condition, or throws the final DriveError for permanent ones. */
  private classify(status: number, info: ErrorInfo): Transient {
    if (status === 429) return { kind: 'rate_limit', status }
    if (status === 408 || status >= 500) return { kind: 'server', status }
    if (status === 403) {
      if (info.reasons.some((r) => RATE_LIMIT_REASONS.has(r))) return { kind: 'rate_limit', status }
      const reason = info.reasons.find((r) => r in CANNOT_DOWNLOAD_MESSAGES)
      if (reason !== undefined) throw new DriveError('cannot_download', CANNOT_DOWNLOAD_MESSAGES[reason] ?? reason, status)
      throw new DriveError('forbidden', 'k souboru nemáte přístup', status)
    }
    if (status === 404) throw new DriveError('not_found', 'soubor na Google Disku už neexistuje', status)
    // Anything else (400, 416, 3xx, ...) will not get better by waiting.
    throw new DriveError('server', `Google Disk odmítl žádost (HTTP ${status})${info.message ? `: ${info.message}` : ''}`, status)
  }

  /**
   * Token calls. Returns the token, or a transient `network` failure to retry; throws for `auth` (provider's
   * DriveError, or any non-DriveError error) so the request stops at once. An abort throws the signal's reason.
   */
  private async acquire(fn: (signal?: AbortSignal) => Promise<string>, signal: AbortSignal | undefined): Promise<string | Transient> {
    try {
      return await abortable(() => fn(signal), signal)
    } catch (cause) {
      if (signal?.aborted) throw signal.reason
      if (cause instanceof DriveError) {
        if (cause.kind === 'network') return { kind: 'network', status: null, cause }
        throw cause
      }
      throw new DriveError('auth', 'nepodařilo se obnovit přihlášení ke Google Disku', null, { cause })
    }
  }
}
