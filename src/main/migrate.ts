import * as fs from 'node:fs/promises'
import { join } from 'node:path'

/** Files of the old Třídění karet app that the new app takes over. `apikey.bin` is not one: its Keychain item belongs to the old app. */
const FILES = ['settings.json', 'journal.jsonl'] as const
/** Written into the new app's folder after the first attempt: the import never runs again. */
export const IMPORT_MARKER = '.imported-trideni-karet'

function errorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined
}

/**
 * One-time, read-only import of the old Třídění karet data (`fromDir`) into the new app's userData (`toDir`).
 * A file is copied only when the new app has none yet and the old one is a regular file (symlinks are not
 * followed). Never writes to `fromDir`, never overwrites anything in `toDir`. Runs once: afterwards `toDir`
 * holds `IMPORT_MARKER` and later starts copy nothing (also when the user removed a file on purpose).
 */
export async function importTrideniData(opts: { fromDir: string; toDir: string; log: (m: string) => void }): Promise<{ imported: string[] }> {
  const imported: string[] = []
  const marker = join(opts.toDir, IMPORT_MARKER)
  try {
    await fs.mkdir(opts.toDir, { recursive: true })
    await fs.lstat(marker)
    return { imported } // already done on an earlier start
  } catch (e) {
    if (errorCode(e) !== 'ENOENT') {
      opts.log(`import: cannot check the marker (${errorCode(e) ?? 'unknown'})`)
      return { imported }
    }
  }
  for (const name of FILES) {
    const src = join(opts.fromDir, name)
    const dst = join(opts.toDir, name)
    try {
      await fs.lstat(dst)
      continue // the new app already has its own file
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') {
        opts.log(`import ${name}: target check failed (${errorCode(e) ?? 'unknown'})`)
        continue
      }
    }
    try {
      const st = await fs.lstat(src)
      if (!st.isFile()) continue
      await fs.copyFile(src, dst, fs.constants.COPYFILE_EXCL)
      imported.push(name)
    } catch (e) {
      const code = errorCode(e)
      if (code !== 'ENOENT' && code !== 'EEXIST') opts.log(`import ${name}: copy failed (${code ?? 'unknown'})`)
    }
  }
  try {
    await fs.writeFile(marker, `${new Date().toISOString()} ${imported.join(',')}\n`, { flag: 'wx' })
  } catch (e) {
    opts.log(`import: marker not written (${errorCode(e) ?? 'unknown'})`)
  }
  return { imported }
}
