import { createHash } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveError } from '../../../src/core/download/drive'
import {
  AuthService,
  DRIVE_READONLY_SCOPE,
  SIGN_IN_CANCELLED,
  SIGN_IN_FAILED,
  SIGN_IN_SCOPE_MISSING,
  SIGN_IN_TIMEOUT,
  startLoopback,
} from '../../../src/main/download/auth'
import { KEYCHAIN_UNAVAILABLE, type TokenStore } from '../../../src/main/download/token-store'

const REFRESH = '1//refresh-SECRET-abc'
const ACCESS = 'ya29.access-1'
const EMAIL = 'jan@sportivea.cz'

type TokenReply = { status: number; body: Record<string, unknown> } | 'hang'

/** Fake Google token, revoke and Drive /about endpoints on 127.0.0.1. */
class FakeGoogle {
  tokenRequests: URLSearchParams[] = []
  revoked: string[] = []
  aboutAuth: string[] = []
  tokenReply: () => TokenReply = () => ({ status: 200, body: this.tokens() })
  aboutStatus = 200
  private server: http.Server
  baseUrl = ''
  private nextAccess = 1

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (req.method === 'POST' && url.pathname === '/token') {
          this.tokenRequests.push(new URLSearchParams(Buffer.concat(chunks).toString()))
          const reply = this.tokenReply()
          if (reply === 'hang') return
          res.writeHead(reply.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(reply.body))
          return
        }
        if (req.method === 'POST' && url.pathname === '/revoke') {
          this.revoked.push(url.searchParams.get('token') ?? new URLSearchParams(Buffer.concat(chunks).toString()).get('token') ?? '')
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        if (req.method === 'GET' && url.pathname === '/about') {
          this.aboutAuth.push(req.headers.authorization ?? '')
          res.writeHead(this.aboutStatus, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ user: { emailAddress: EMAIL } }))
          return
        }
        res.writeHead(404)
        res.end()
      })
    })
  }

  tokens(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const access = `ya29.access-${this.nextAccess++}`
    return { access_token: access, refresh_token: REFRESH, expires_in: 3599, scope: DRIVE_READONLY_SCOPE, token_type: 'Bearer', ...extra }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.baseUrl = `http://127.0.0.1:${port}`
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

class MemoryStore implements TokenStore {
  token: string | null = null
  available = true
  saves = 0
  async isAvailable(): Promise<boolean> {
    return this.available
  }
  async saveRefreshToken(t: string): Promise<void> {
    if (!this.available) throw new Error(KEYCHAIN_UNAVAILABLE)
    this.saves += 1
    this.token = t
  }
  async loadRefreshToken(): Promise<string | null> {
    return this.token
  }
  async clearRefreshToken(): Promise<void> {
    this.token = null
  }
}

let google: FakeGoogle
let store: MemoryStore
let opened: string[]
let clock: number
let logs: string[]

function makeAuth(over: Partial<ConstructorParameters<typeof AuthService>[0]> = {}): AuthService {
  return new AuthService({
    config: () => ({ clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret' }),
    store,
    openExternal: async (url) => {
      opened.push(url)
    },
    endpoints: { oauth2TokenUrl: `${google.baseUrl}/token`, oauth2RevokeUrl: `${google.baseUrl}/revoke` },
    aboutUrl: `${google.baseUrl}/about`,
    now: () => clock,
    log: (m) => logs.push(m),
    ...over,
  })
}

/** Waits until the auth URL was opened and returns it parsed. */
async function openedUrl(): Promise<URL> {
  await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0))
  return new URL(opened[opened.length - 1] ?? '')
}

/** Plays the browser: follows Google's redirect back to the loopback server. */
async function callback(url: URL, query: Record<string, string>, path = '/'): Promise<{ status: number; text: string; csp: string | null }> {
  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
  const target = new URL(path, redirect)
  for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v)
  const res = await fetch(target)
  return { status: res.status, text: await res.text(), csp: res.headers.get('content-security-policy') }
}

beforeEach(async () => {
  google = new FakeGoogle()
  await google.start()
  store = new MemoryStore()
  opened = []
  clock = 1_000_000
  logs = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  await google.close()
})

describe('sign-in', () => {
  it('opens a PKCE auth URL for drive.readonly with a loopback redirect, exchanges the code and stores the token', async () => {
    const auth = makeAuth()
    const result = auth.signIn()
    const url = await openedUrl()

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(opened[0]).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly')
    expect(url.searchParams.get('scope')).toBe(DRIVE_READONLY_SCOPE)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('include_granted_scopes')).toBeNull()
    const redirect = url.searchParams.get('redirect_uri') ?? ''
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const state = url.searchParams.get('state') ?? ''
    expect(state.length).toBeGreaterThanOrEqual(32)

    const page = await callback(url, { state, code: 'auth-code-1' })
    expect(page.status).toBe(200)
    expect(page.text).toContain('Přihlášení proběhlo, můžeš zavřít okno.')
    expect(page.text).not.toMatch(/<script|<link|<img|src=|href=/i)
    expect(page.csp).toBe("default-src 'none'")

    await expect(result).resolves.toEqual({ ok: true, email: EMAIL })
    const req = google.tokenRequests[0]
    expect(req?.get('grant_type')).toBe('authorization_code')
    expect(req?.get('code')).toBe('auth-code-1')
    expect(req?.get('redirect_uri')).toBe(redirect)
    const verifier = req?.get('code_verifier') ?? ''
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
    expect(store.token).toBe(REFRESH)
    expect(google.aboutAuth).toEqual([`Bearer ${ACCESS}`])
    expect(await auth.status()).toEqual({ signedIn: true, email: EMAIL })
  })

  it('rejects a callback with a wrong state and keeps waiting for the real one', async () => {
    const auth = makeAuth()
    const result = auth.signIn()
    const url = await openedUrl()
    const state = url.searchParams.get('state') ?? ''

    const bad = await callback(url, { state: `${state.slice(0, -1)}X`, code: 'evil-code' })
    expect(bad.status).toBe(400)
    const missing = await callback(url, { code: 'evil-code' })
    expect(missing.status).toBe(400)
    const other = await callback(url, { state, code: 'evil-code' }, '/favicon.ico')
    expect(other.status).toBe(404)
    expect(google.tokenRequests).toHaveLength(0)

    await callback(url, { state, code: 'good-code' })
    await expect(result).resolves.toEqual({ ok: true, email: EMAIL })
    expect(google.tokenRequests.map((r) => r.get('code'))).toEqual(['good-code'])
  })

  it('accepts exactly one callback, then the loopback server is closed', async () => {
    const auth = makeAuth()
    const result = auth.signIn()
    const url = await openedUrl()
    const state = url.searchParams.get('state') ?? ''
    await callback(url, { state, code: 'first' })
    await result
    await expect(callback(url, { state, code: 'second' })).rejects.toThrow()
    expect(google.tokenRequests.map((r) => r.get('code'))).toEqual(['first'])
  })

  it('fails with a Czech message when the user denies access', async () => {
    const auth = makeAuth()
    const result = auth.signIn()
    const url = await openedUrl()
    await callback(url, { state: url.searchParams.get('state') ?? '', error: 'access_denied' })
    await expect(result).resolves.toEqual({ ok: false, error: SIGN_IN_CANCELLED })
    expect(store.token).toBeNull()
  })

  it('times out', async () => {
    const auth = makeAuth({ timeoutMs: 100 })
    await expect(auth.signIn()).resolves.toEqual({ ok: false, error: SIGN_IN_TIMEOUT })
  })

  it('fails before opening the browser when the Keychain is unavailable', async () => {
    store.available = false
    const auth = makeAuth()
    await expect(auth.signIn()).resolves.toEqual({ ok: false, error: KEYCHAIN_UNAVAILABLE })
    expect(opened).toEqual([])
  })

  it('fails with the Czech config message when the OAuth client is missing', async () => {
    const auth = makeAuth({
      config: () => {
        throw new Error('Chybí nastavení přihlášení Google (OAuth klient).')
      },
    })
    await expect(auth.signIn()).resolves.toEqual({ ok: false, error: 'Chybí nastavení přihlášení Google (OAuth klient).' })
  })

  it('refuses a grant without drive.readonly (user unticked it) and revokes it', async () => {
    google.tokenReply = () => ({ status: 200, body: google.tokens({ scope: 'openid' }) })
    const auth = makeAuth()
    const result = auth.signIn()
    const url = await openedUrl()
    await callback(url, { state: url.searchParams.get('state') ?? '', code: 'c' })
    await expect(result).resolves.toEqual({ ok: false, error: SIGN_IN_SCOPE_MISSING })
    expect(store.token).toBeNull()
    await vi.waitFor(() => expect(google.revoked).toEqual([REFRESH]))
  })

  it('a failing token save shows only a Czech message, never raw fs text with paths', async () => {
    store.saveRefreshToken = async () => {
      throw Object.assign(new Error("EACCES: permission denied, open '/Users/x/Library/Application Support/app/google-token.bin.tmp'"), {
        code: 'EACCES',
      })
    }
    const auth = makeAuth()
    const result = auth.signIn()
    const url = await openedUrl()
    await callback(url, { state: url.searchParams.get('state') ?? '', code: 'c' })
    const r = await result
    expect(r).toEqual({ ok: false, error: SIGN_IN_FAILED })
    expect(JSON.stringify(r)).not.toContain('/')
    expect(logs.join('\n')).toContain('EACCES')
    expect(logs.join('\n')).not.toContain('/Users/x')
  })

  it('a Keychain failure during the save passes the Czech Keychain message through', async () => {
    store.saveRefreshToken = async () => {
      throw new Error(KEYCHAIN_UNAVAILABLE)
    }
    const auth = makeAuth()
    const result = auth.signIn()
    const url = await openedUrl()
    await callback(url, { state: url.searchParams.get('state') ?? '', code: 'c' })
    await expect(result).resolves.toEqual({ ok: false, error: KEYCHAIN_UNAVAILABLE })
  })

  it('does not open a non-Google auth URL', async () => {
    const auth = makeAuth({ endpoints: { oauth2AuthBaseUrl: 'https://evil.example/auth', oauth2TokenUrl: `${google.baseUrl}/token` } })
    const result = await auth.signIn()
    expect(result.ok).toBe(false)
    expect(opened).toEqual([])
  })

  it('a second sign-in cancels the first one', async () => {
    const auth = makeAuth()
    const first = auth.signIn()
    await openedUrl()
    const second = auth.signIn()
    await expect(first).resolves.toMatchObject({ ok: false })
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    const url = new URL(opened[1] ?? '')
    await callback(url, { state: url.searchParams.get('state') ?? '', code: 'c' })
    await expect(second).resolves.toEqual({ ok: true, email: EMAIL })
  })

  it('never puts the refresh token in a result or a log line', async () => {
    const consoleLines: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(' '))
      })
    }
    const auth = makeAuth()
    const result = auth.signIn()
    const url = await openedUrl()
    await callback(url, { state: url.searchParams.get('state') ?? '', code: 'c' })
    const signed = await result
    clock += 3_600_000
    await auth.tokens.getAccessToken()
    google.tokenReply = () => ({ status: 400, body: { error: 'invalid_grant', error_description: `Bad ${REFRESH}` } })
    await auth.tokens.refresh().catch(() => undefined)
    await auth.signOut()
    const everything = [JSON.stringify(signed), JSON.stringify(await auth.status()), ...logs, ...consoleLines].join('\n')
    expect(everything).not.toContain(REFRESH)
    expect(everything).not.toContain('GOCSPX')
  })
})

describe('loopback server', () => {
  it('binds 127.0.0.1 only and answers 404 to other paths', async () => {
    const loop = await startLoopback({ state: 's'.repeat(43), timeoutMs: 5000 })
    try {
      expect(loop.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const res = await fetch(`${loop.redirectUri}/other?state=${'s'.repeat(43)}&code=x`)
      expect(res.status).toBe(404)
      const post = await fetch(`${loop.redirectUri}/?state=${'s'.repeat(43)}&code=x`, { method: 'POST' })
      expect(post.status).toBe(404)
    } finally {
      loop.close()
    }
    await expect(loop.callback).rejects.toThrow()
  })
})

describe('token provider', () => {
  async function signedIn(): Promise<AuthService> {
    store.token = REFRESH
    return makeAuth()
  }

  it('refreshes on first use, keeps the token in memory and refreshes within 60 s of expiry', async () => {
    const auth = await signedIn()
    expect(await auth.tokens.getAccessToken()).toBe('ya29.access-1')
    expect(await auth.tokens.getAccessToken()).toBe('ya29.access-1')
    expect(google.tokenRequests).toHaveLength(1)
    expect(google.tokenRequests[0]?.get('grant_type')).toBe('refresh_token')
    expect(google.tokenRequests[0]?.get('refresh_token')).toBe(REFRESH)

    clock += 3_599_000 - 61_000 // 61 s before expiry: still fine
    expect(await auth.tokens.getAccessToken()).toBe('ya29.access-1')
    clock += 2_000 // 59 s before expiry: refresh
    expect(await auth.tokens.getAccessToken()).toBe('ya29.access-2')
    expect(google.tokenRequests).toHaveLength(2)
  })

  it('refresh() forces a new token; concurrent refreshes share one request', async () => {
    const auth = await signedIn()
    await auth.tokens.getAccessToken()
    const [a, b] = await Promise.all([auth.tokens.refresh(), auth.tokens.refresh()])
    expect(a).toBe('ya29.access-2')
    expect(b).toBe('ya29.access-2')
    expect(google.tokenRequests).toHaveLength(2)
  })

  it('invalid_grant is DriveError auth', async () => {
    google.tokenReply = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } })
    const auth = await signedIn()
    const err = await auth.tokens.getAccessToken().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DriveError)
    expect((err as DriveError).kind).toBe('auth')
    expect((err as DriveError).cause).toBeUndefined()
  })

  it('5xx from the token endpoint is DriveError network', async () => {
    google.tokenReply = () => ({ status: 503, body: { error: 'backend' } })
    const auth = await signedIn()
    const err = await auth.tokens.refresh().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DriveError)
    expect((err as DriveError).kind).toBe('network')
  })

  it('a connection failure is DriveError network', async () => {
    const auth = makeAuth({ endpoints: { oauth2TokenUrl: 'http://127.0.0.1:1/token' } })
    store.token = REFRESH
    const err = await auth.tokens.refresh().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DriveError)
    expect((err as DriveError).kind).toBe('network')
  })

  it('without a stored token it is DriveError auth', async () => {
    const auth = makeAuth()
    const err = await auth.tokens.getAccessToken().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DriveError)
    expect((err as DriveError).kind).toBe('auth')
    expect(google.tokenRequests).toHaveLength(0)
  })

  it('an already-aborted signal gives a rejected promise, not a synchronous throw', async () => {
    const auth = await signedIn()
    const controller = new AbortController()
    const reason = new Error('stop')
    controller.abort(reason)
    let pending: Promise<string> | undefined
    expect(() => {
      pending = auth.tokens.refresh(controller.signal)
    }).not.toThrow()
    await expect(pending).rejects.toBe(reason)
    let pending2: Promise<string> | undefined
    expect(() => {
      pending2 = auth.tokens.getAccessToken(controller.signal)
    }).not.toThrow()
    await expect(pending2).rejects.toBe(reason)
    expect(google.tokenRequests).toHaveLength(0)
  })

  it('honours the abort signal', async () => {
    google.tokenReply = () => 'hang'
    const auth = await signedIn()
    const controller = new AbortController()
    const pending = auth.tokens.refresh(controller.signal)
    await vi.waitFor(() => expect(google.tokenRequests).toHaveLength(1))
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    const already = new AbortController()
    already.abort(reason)
    await expect(auth.tokens.getAccessToken(already.signal)).rejects.toBe(reason)
  })
})

describe('status and sign-out', () => {
  it('status is signed out without a stored token', async () => {
    expect(await makeAuth().status()).toEqual({ signedIn: false, email: null })
  })

  it('status reads the email from Drive /about with a stored token', async () => {
    store.token = REFRESH
    expect(await makeAuth().status()).toEqual({ signedIn: true, email: EMAIL })
  })

  it('status stays signed in (email unknown) when offline', async () => {
    store.token = REFRESH
    google.tokenReply = () => ({ status: 503, body: {} })
    expect(await makeAuth().status()).toEqual({ signedIn: true, email: null })
  })

  it('sign-out deletes the stored token, forgets the access token and revokes best-effort', async () => {
    store.token = REFRESH
    const auth = makeAuth()
    await auth.tokens.getAccessToken()
    await auth.signOut()
    expect(store.token).toBeNull()
    expect(google.revoked).toEqual([REFRESH])
    expect(await auth.status()).toEqual({ signedIn: false, email: null })
    await expect(auth.tokens.getAccessToken()).rejects.toMatchObject({ kind: 'auth' })
  })

  it('sign-out succeeds when the revoke fails', async () => {
    store.token = REFRESH
    const auth = makeAuth({ endpoints: { oauth2TokenUrl: `${google.baseUrl}/token`, oauth2RevokeUrl: 'http://127.0.0.1:1/revoke' } })
    await expect(auth.signOut()).resolves.toBeUndefined()
    expect(store.token).toBeNull()
  })
})
