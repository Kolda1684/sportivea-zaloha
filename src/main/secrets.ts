import { app, safeStorage } from 'electron'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'

const KEYCHAIN_UNAVAILABLE = 'Klíčenka macOS není dostupná, klíč nejde bezpečně uložit.'

function keyFile(): string {
  return join(app.getPath('userData'), 'apikey.bin')
}

/** Encrypts the key with the macOS Keychain (Electron safeStorage) and stores it in userData. Never falls back to plain text. */
export async function saveApiKey(key: string): Promise<void> {
  const trimmed = key.trim()
  if (trimmed === '') throw new Error('Klíč je prázdný.')
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error(KEYCHAIN_UNAVAILABLE)
  const encrypted = await safeStorage.encryptStringAsync(trimmed)
  const file = keyFile()
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, encrypted, { mode: 0o600 })
  try {
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

/** The stored key, or null when none is saved or it cannot be decrypted. */
export async function loadApiKey(): Promise<string | null> {
  let encrypted: Buffer
  try {
    encrypted = await fs.readFile(keyFile())
  } catch {
    return null
  }
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted)
    if (result === '') return null
    if (shouldReEncrypt) await saveApiKey(result).catch(() => undefined)
    return result
  } catch {
    return null
  }
}
