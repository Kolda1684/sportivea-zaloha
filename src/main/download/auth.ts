import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as http from 'node:http'
import { CodeChallengeMethod, OAuth2Client, gaxios, type Credentials, type OAuth2ClientOptions } from 'google-auth-library'
import { z } from 'zod'
import { errCode } from '../../core/download/download-steps'
import { DriveError, type TokenProvider } from '../../core/download/drive'
import type { AuthStatus, SignInResult } from '../../shared/download-ipc'
import type { OAuthConfig } from './oauth-config'
import { KEYCHAIN_UNAVAILABLE, type TokenStore } from './token-store'

/**
 * Google sign-in for a desktop app: OAuth 2.0 with PKCE and a loopback redirect to 127.0.0.1, scope exactly
 * `drive.readonly`. The refresh token lives only in the token store (Keychain); it is never returned, sent over IPC,
 * logged or attached to an error. Library errors are never logged as objects: they carry the request (with the
 * refresh token or client secret) in `config`.
 */

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const GOOGLE_AUTH_PREFIX = 'https://accounts.google.com/'
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)'
const CALLBACK_PATH = '/'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const HTTP_TIMEOUT_MS = 30_000
const REVOKE_TIMEOUT_MS = 10_000
/** An access token this close to its expiry is refreshed before use. */
const REFRESH_MARGIN_MS = 60_000
/** Used only if Google's answer lacks `expires_in` (it never should). */
const FALLBACK_LIFETIME_MS = 10 * 60_000

export const SIGN_IN_TIMEOUT = 'Přihlášení vypršelo. Zkus to znovu.'
export const SIGN_IN_CANCELLED = 'Přihlášení bylo zrušeno.'
export const SIGN_IN_ABORTED = 'Přihlášení bylo přerušeno.'
export const SIGN_IN_FAILED = 'Přihlášení se nepodařilo. Zkus to znovu.'
export const SIGN_IN_SCOPE_MISSING = 'Aplikace potřebuje oprávnění číst soubory na Disku. Přihlas se znovu a povol ho.'
export const SIGN_IN_NO_EMAIL = 'Nepodařilo se zjistit účet Google. Zkontroluj internet a zkus to znovu.'
const AUTH_LOST = 'přihlášení ke Google Disku vypršelo, přihlas se znovu'
const NETWORK_DOWN = 'výpadek připojení k internetu'

const PAGE_DONE = 'Přihlášení proběhlo, můžeš zavřít okno.'
const PAGE_CANCELLED = 'Přihlášení bylo zrušeno. Můžeš zavřít okno a zkusit to znovu.'
const PAGE_BAD_REQUEST = 'Neplatná odpověď přihlášení.'
const PAGE_NOT_FOUND = 'Stránka neexistuje.'

/** An error whose message is Czech text meant for the user. */
class SignInError extends Error {
  override readonly name = 'SignInError'
}

const AboutSchema = z.object({ user: z.object({ emailAddress: z.string().min(3).max(320) }) })

function page(text: string): string {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>Stahování z Disku</title></head><body><p>${text}</p></body></html>`
}

function respond(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  })
  res.end(page(text))
}

/** Constant-time comparison of two secrets (length leaks, content does not). */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
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

/** Short, secret-free description of an error for the log: name, HTTP status and error code only. */
function describeError(e: unknown): string {
  if (e instanceof gaxios.GaxiosError) {
    const data = z.object({ error: z.string().max(64) }).safeParse(e.response?.data)
    return `GaxiosError status=${e.response?.status ?? e.status ?? '-'} code=${data.success ? data.data.error : String(e.code ?? '-')}`
  }
  if (e instanceof DriveError) return `DriveError ${e.kind}`
  if (e instanceof Error) return e.name
  return typeof e
}

export type Loopback = {
  /** `http://127.0.0.1:<port>`, the redirect URI sent to Google. */
  redirectUri: string
  /** Resolves with the authorization code of the first valid callback; rejects (Czech message) otherwise. */
  callback: Promise<string>
  /** Stops waiting and closes the server (a pending `callback` rejects). */
  close(): void
}

/**
 * HTTP server on 127.0.0.1, random port, that receives Google's redirect. Only `GET /` with the right `state`
 * (constant-time compare) counts; any other path or method gets 404, a wrong or missing state 400 (and it keeps
 * waiting). The first valid callback, the timeout or an abort closes it. The pages load nothing external.
 */
export async function startLoopback(opts: { state: string; timeoutMs: number; signal?: AbortSignal }): Promise<Loopback> {
  const server = http.createServer()
  let settled = false
  let resolveCode: (code: string) => void = () => undefined
  let rejectCode: (e: Error) => void = () => undefined
  const callback = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // A caller that stops waiting (e.g. after a failed openExternal) must not cause an unhandled rejection.
  callback.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const onAbort = (): void => finish(new SignInError(SIGN_IN_ABORTED))

  function finish(outcome: Error | { code: string }): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    server.close()
    server.closeIdleConnections()
    if (outcome instanceof Error) rejectCode(outcome)
    else resolveCode(outcome.code)
  }

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (settled || req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      respond(res, 404, PAGE_NOT_FOUND)
      return
    }
    const state = url.searchParams.get('state')
    if (state === null || !sameSecret(state, opts.state)) {
      respond(res, 400, PAGE_BAD_REQUEST)
      return
    }
    // From here on this is the one accepted callback: the server closes once the page is sent.
    res.on('finish', () => server.closeAllConnections())
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (error !== null || code === null || code === '') {
      respond(res, 200, PAGE_CANCELLED)
      finish(new SignInError(error === 'access_denied' ? SIGN_IN_CANCELLED : SIGN_IN_FAILED))
      return
    }
    respond(res, 200, PAGE_DONE)
    finish({ code })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new SignInError(SIGN_IN_FAILED)
  }
  timer = setTimeout(() => finish(new SignInError(SIGN_IN_TIMEOUT)), opts.timeoutMs)
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })

  return {
    redirectUri: `http://127.0.0.1:${address.port}`,
    callback,
    close: () => finish(new SignInError(SIGN_IN_ABORTED)),
  }
}

/** Maps a failed refresh to the TokenProvider contract: transient → `network`, rejected grant → `auth`. */
function refreshError(e: unknown): DriveError {
  if (e instanceof DriveError) return e
  if (e instanceof gaxios.GaxiosError) {
    const status = e.response?.status ?? e.status
    // No answer at all (connection refused, DNS, timeout) or a server-side problem: worth retrying.
    if (status === undefined || status >= 500 || status === 408 || status === 429) {
      return new DriveError('network', NETWORK_DOWN)
    }
    // 400 invalid_grant (expired / revoked), 401 invalid_client, ...: waiting will not help.
    return new DriveError('auth', AUTH_LOST, status)
  }
  return new DriveError('auth', AUTH_LOST)
}

export type AuthDeps = {
  /** OAuth client values (throws a Czech message when missing): `getOAuthConfig`. */
  config: () => OAuthConfig
  store: TokenStore
  /** Opens the system browser (`shell.openExternal`). Only ever called with an `https://accounts.google.com/` URL. */
  openExternal: (url: string) => Promise<void>
  /** Test hook: fake token / revoke endpoints. */
  endpoints?: OAuth2ClientOptions['endpoints']
  /** Test hook: fake Drive `/about`. */
  aboutUrl?: string
  timeoutMs?: number
  now?: () => number
  log?: (message: string) => void
}

type AccessToken = { token: string; expiresAt: number }

/** Sign-in state of the app and the `TokenProvider` for the Drive client. */
export class AuthService {
  readonly tokens: TokenProvider
  private readonly deps: AuthDeps
  private readonly now: () => number
  private readonly log: (message: string) => void
  /** `undefined` = not read from the store yet; `null` = none. */
  private refreshToken: string | null | undefined = undefined
  private access: AccessToken | null = null
  private email: string | null = null
  private refreshing: Promise<string> | null = null
  /** Bumped on sign-in / sign-out so that work started before cannot store stale state. */
  private generation = 0
  private pendingSignIn: AbortController | null = null

  constructor(deps: AuthDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((m) => console.log(`[auth] ${m}`))
    this.tokens = {
      getAccessToken: (signal) => this.getAccessToken(signal),
      refresh: (signal) => this.refresh(signal),
    }
  }

  async hasRefreshToken(): Promise<boolean> {
    return (await this.loadRefreshToken()) !== null
  }

  async status(): Promise<AuthStatus> {
    if ((await this.loadRefreshToken()) === null) return { signedIn: false, email: null }
    if (this.email === null) {
      const generation = this.generation
      try {
        const email = await this.fetchEmail(await this.getAccessToken())
        if (generation === this.generation) this.email = email
      } catch (e) {
        if (e instanceof DriveError && e.kind === 'auth') return { signedIn: false, email: null }
        this.log(`status: email not read (${describeError(e)})`)
      }
    }
    return { signedIn: true, email: this.email }
  }

  /** Runs the browser sign-in. A new call cancels a pending one. Never throws. */
  async signIn(): Promise<SignInResult> {
    this.pendingSignIn?.abort()
    const controller = new AbortController()
    this.pendingSignIn = controller
    try {
      return { ok: true, email: await this.runSignIn(controller.signal) }
    } catch (e) {
      if (e instanceof SignInError) return { ok: false, error: e.message }
      if (controller.signal.aborted) return { ok: false, error: SIGN_IN_ABORTED }
      this.log(`sign-in failed (${describeError(e)})`)
      return { ok: false, error: SIGN_IN_FAILED }
    } finally {
      if (this.pendingSignIn === controller) this.pendingSignIn = null
    }
  }

  /** Forgets everything, deletes the stored token and revokes it at Google (best effort). Never throws. */
  async signOut(): Promise<void> {
    this.pendingSignIn?.abort()
    const token = await this.loadRefreshToken().catch(() => null)
    this.generation += 1
    this.refreshToken = null
    this.access = null
    this.email = null
    this.refreshing = null
    try {
      await this.deps.store.clearRefreshToken()
    } catch (e) {
      this.log(`sign-out: token file not deleted (${describeError(e)})`)
    }
    if (token !== null) await this.revoke(token)
  }

  private async runSignIn(signal: AbortSignal): Promise<string> {
    let config: OAuthConfig
    try {
      config = this.deps.config()
    } catch (e) {
      throw new SignInError(e instanceof Error ? e.message : SIGN_IN_FAILED)
    }
    if (!(await this.deps.store.isAvailable())) throw new SignInError(KEYCHAIN_UNAVAILABLE)
    const client = this.client(config)
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
    if (codeChallenge === undefined) throw new SignInError(SIGN_IN_FAILED)
    const state = randomBytes(32).toString('base64url')

    const loop = await startLoopback({ state, timeoutMs: this.deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS, signal })
    let code: string
    try {
      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [DRIVE_READONLY_SCOPE],
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        redirect_uri: loop.redirectUri,
      })
      if (!authUrl.startsWith(GOOGLE_AUTH_PREFIX)) throw new SignInError(SIGN_IN_FAILED)
      await this.deps.openExternal(authUrl)
      code = await loop.callback
    } finally {
      loop.close()
    }

    let tokens: Credentials
    try {
      tokens = (await abortable(() => client.getToken({ code, codeVerifier, redirect_uri: loop.redirectUri }), signal)).tokens
    } catch (e) {
      if (signal.aborted) throw new SignInError(SIGN_IN_ABORTED)
      this.log(`token exchange failed (${describeError(e)})`)
      throw new SignInError(SIGN_IN_FAILED)
    }
    const refreshToken = tokens.refresh_token
    const accessToken = tokens.access_token
    if (typeof refreshToken !== 'string' || refreshToken === '' || typeof accessToken !== 'string' || accessToken === '') {
      throw new SignInError(SIGN_IN_FAILED)
    }
    // Google lets the user untick the permission on the consent screen.
    if (!(tokens.scope ?? '').split(' ').includes(DRIVE_READONLY_SCOPE)) {
      void this.revoke(refreshToken)
      throw new SignInError(SIGN_IN_SCOPE_MISSING)
    }

    let email: string
    try {
      email = await this.fetchEmail(accessToken, signal)
    } catch (e) {
      if (signal.aborted) throw new SignInError(SIGN_IN_ABORTED)
      this.log(`account email not read (${describeError(e)})`)
      throw new SignInError(SIGN_IN_NO_EMAIL)
    }
    signal.throwIfAborted()

    try {
      await this.deps.store.saveRefreshToken(refreshToken)
    } catch (e) {
      // Only our own Czech Keychain message reaches the UI; fs / safeStorage texts are English and contain paths.
      if (e instanceof Error && e.message === KEYCHAIN_UNAVAILABLE) throw new SignInError(KEYCHAIN_UNAVAILABLE)
      this.log(`token not saved (${errCode(e) ?? describeError(e)})`)
      throw new SignInError(SIGN_IN_FAILED)
    }
    // A sign-out (or a new sign-in) during the save wins: do not leave this token behind.
    if (signal.aborted) {
      await this.deps.store.clearRefreshToken().catch(() => undefined)
      throw new SignInError(SIGN_IN_ABORTED)
    }
    this.generation += 1
    this.refreshToken = refreshToken
    this.access = { token: accessToken, expiresAt: this.expiresAt(tokens) }
    this.refreshing = null
    this.email = email
    return email
  }

  private client(config: OAuthConfig): OAuth2Client {
    return new OAuth2Client({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      endpoints: this.deps.endpoints,
      // Off: the default interceptors only add headers and debug logging, and that logging would print token answers.
      useAuthRequestParameters: false,
      // Node's own fetch (not node-fetch, not Electron's net); a hung token endpoint gives up after 30 s.
      transporterOptions: { fetchImplementation: (input, init) => fetch(input, init), timeout: HTTP_TIMEOUT_MS },
    })
  }

  private async loadRefreshToken(): Promise<string | null> {
    if (this.refreshToken !== undefined) return this.refreshToken
    const generation = this.generation
    const token = await this.deps.store.loadRefreshToken()
    if (generation !== this.generation) return this.refreshToken ?? null
    this.refreshToken = token
    return token
  }

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const access = this.access
    if (access !== null && this.now() < access.expiresAt - REFRESH_MARGIN_MS) return access.token
    return this.refresh(signal)
  }

  /** Async, so an aborted signal rejects the promise instead of throwing synchronously. */
  private async refresh(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (this.refreshing === null) {
      const p = this.doRefresh().finally(() => {
        if (this.refreshing === p) this.refreshing = null
      })
      this.refreshing = p
    }
    const shared = this.refreshing
    return abortable(() => shared, signal)
  }

  private async doRefresh(): Promise<string> {
    const generation = this.generation
    const refreshToken = await this.loadRefreshToken()
    if (refreshToken === null) throw new DriveError('auth', AUTH_LOST)
    let credentials: Credentials
    try {
      const client = this.client(this.deps.config())
      client.setCredentials({ refresh_token: refreshToken })
      credentials = (await client.refreshAccessToken()).credentials
    } catch (e) {
      const mapped = refreshError(e)
      this.log(`token refresh failed (${describeError(e)})`)
      throw mapped
    }
    if (generation !== this.generation) throw new DriveError('auth', AUTH_LOST)
    const token = credentials.access_token
    if (typeof token !== 'string' || token === '') throw new DriveError('network', NETWORK_DOWN)
    this.access = { token, expiresAt: this.expiresAt(credentials) }
    return token
  }

  /** The library stamps `expiry_date` with the wall clock; keep the remaining lifetime, measured on `now`. */
  private expiresAt(credentials: Credentials): number {
    const expiry = credentials.expiry_date
    const lifetime = typeof expiry === 'number' ? expiry - Date.now() : FALLBACK_LIFETIME_MS
    return this.now() + lifetime
  }

  private async fetchEmail(accessToken: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS)
    const res = await fetch(this.deps.aboutUrl ?? ABOUT_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`about HTTP ${res.status}`)
    }
    return AboutSchema.parse(await res.json()).user.emailAddress
  }

  private async revoke(token: string): Promise<void> {
    try {
      const client = this.client(this.deps.config())
      await abortable(() => client.revokeToken(token), AbortSignal.timeout(REVOKE_TIMEOUT_MS))
    } catch (e) {
      this.log(`revoke failed (${describeError(e)})`)
    }
  }
}
