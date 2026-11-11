import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'

export const TOKEN_FILE_NAME = 'google-token.bin'
export const KEYCHAIN_UNAVAILABLE = 'Klíčenka macOS není dostupná, přihlášení nejde bezpečně uložit.'

/** The part of Electron's `safeStorage` the store uses (injected so tests run without Electron). */
export type SafeStorageLike = {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export type TokenStore = {
  /** Whether the Keychain can encrypt; without it nothing is ever stored. */
  isAvailable(): Promise<boolean>
  saveRefreshToken(token: string): Promise<void>
  /** The stored token, or `null` when none is stored or it cannot be decrypted. */
  loadRefreshToken(): Promise<string | null>
  /** Deletes the app's own token file; a missing file is fine. */
  clearRefreshToken(): Promise<void>
}

/**
 * Google refresh token encrypted with the macOS Keychain (Electron `safeStorage`) in `<dir>/google-token.bin`.
 * Written to a temp file and renamed, so a crash never leaves half a file. Never falls back to plain text.
 */
export function createTokenStore(deps: { safeStorage: SafeStorageLike; dir: string }): TokenStore {
  const { safeStorage, dir } = deps
  const file = join(dir, TOKEN_FILE_NAME)

  const save = async (token: string): Promise<void> => {
    if (token === '') throw new Error('Přihlášení je prázdné.')
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error(KEYCHAIN_UNAVAILABLE)
    const encrypted = await safeStorage.encryptStringAsync(token)
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await fs.writeFile(tmp, encrypted, { mode: 0o600, flag: 'wx' })
      await fs.rename(tmp, file)
    } catch (e) {
      await fs.rm(tmp, { force: true })
      throw e
    }
  }

  return {
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    saveRefreshToken: save,
    async loadRefreshToken() {
      let encrypted: Buffer
      try {
        encrypted = await fs.readFile(file)
      } catch {
        return null
      }
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted)
        if (result === '') return null
        if (shouldReEncrypt) await save(result).catch(() => undefined)
        return result
      } catch {
        return null
      }
    },
    async clearRefreshToken() {
      await fs.rm(file, { force: true })
    },
  }
}
