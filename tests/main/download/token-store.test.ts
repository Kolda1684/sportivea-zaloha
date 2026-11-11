import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEYCHAIN_UNAVAILABLE, TOKEN_FILE_NAME, createTokenStore, type SafeStorageLike } from '../../../src/main/download/token-store'

const TOKEN = '1//refresh-token-SECRET-value'

/** Reversible stand-in for the Keychain: never stores the plain text. */
function fakeSafeStorage(over: Partial<SafeStorageLike> = {}): SafeStorageLike & { reEncrypt: boolean } {
  const s: SafeStorageLike & { reEncrypt: boolean } = {
    reEncrypt: false,
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text: string) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
    decryptStringAsync: async (data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> => {
      const text = data.toString()
      if (!text.startsWith('enc:')) throw new Error('cannot decrypt')
      return { result: Buffer.from(text.slice(4), 'base64').toString(), shouldReEncrypt: s.reEncrypt }
    },
    ...over,
  }
  return s
}

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-store-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('token store', () => {
  it('round-trips the refresh token through safeStorage, never as plain text', async () => {
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    await store.saveRefreshToken(TOKEN)
    const raw = await fs.readFile(path.join(dir, TOKEN_FILE_NAME))
    expect(raw.toString()).not.toContain(TOKEN)
    expect(await store.loadRefreshToken()).toBe(TOKEN)
    // Only the token file remains (temp file was renamed).
    expect(await fs.readdir(dir)).toEqual([TOKEN_FILE_NAME])
  })

  it('writes the file readable by the owner only', async () => {
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    await store.saveRefreshToken(TOKEN)
    const st = await fs.stat(path.join(dir, TOKEN_FILE_NAME))
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('creates the userData directory when missing', async () => {
    const nested = path.join(dir, 'a', 'b')
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir: nested })
    await store.saveRefreshToken(TOKEN)
    expect(await store.loadRefreshToken()).toBe(TOKEN)
  })

  it('refuses to save without the Keychain and never falls back to plain text', async () => {
    const store = createTokenStore({ safeStorage: fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false }), dir })
    expect(await store.isAvailable()).toBe(false)
    await expect(store.saveRefreshToken(TOKEN)).rejects.toThrow(KEYCHAIN_UNAVAILABLE)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('refuses an empty token', async () => {
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    await expect(store.saveRefreshToken('')).rejects.toThrow()
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('returns null when nothing is stored or the file cannot be decrypted', async () => {
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    expect(await store.loadRefreshToken()).toBeNull()
    await fs.writeFile(path.join(dir, TOKEN_FILE_NAME), 'garbage')
    expect(await store.loadRefreshToken()).toBeNull()
  })

  it('re-encrypts when safeStorage asks for it', async () => {
    const safe = fakeSafeStorage()
    const store = createTokenStore({ safeStorage: safe, dir })
    await store.saveRefreshToken(TOKEN)
    safe.reEncrypt = true
    let encrypts = 0
    const original = safe.encryptStringAsync
    safe.encryptStringAsync = async (t) => {
      encrypts += 1
      return original(t)
    }
    expect(await store.loadRefreshToken()).toBe(TOKEN)
    expect(encrypts).toBe(1)
  })

  it('clears the token file; clearing twice is fine', async () => {
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    await store.saveRefreshToken(TOKEN)
    await store.clearRefreshToken()
    expect(await store.loadRefreshToken()).toBeNull()
    await expect(store.clearRefreshToken()).resolves.toBeUndefined()
    expect(await fs.readdir(dir)).toEqual([])
  })
})
