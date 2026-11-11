import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Transform, Writable, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseOriginalName, withConflictSuffix } from './naming'

export type CopyOutcome =
  | { status: 'copied'; destPath: string; bytes: number; sha256: string }
  | { status: 'duplicate'; destPath: string; sha256: string }
  | { status: 'verify_failed'; tempPath: string }

export type CopyOptions = {
  /** Camera tag (e.g. `ILCE7M4`) inserted after the base when `desiredName` is taken by other content. */
  cameraTag?: string
  /**
   * Base (camera clip id, e.g. `C0001`) that the tag is inserted after. Defaults to
   * `parseOriginalName(desiredName).base`. If `desiredName` does not start with the base
   * (followed by `_`, `.` or end), the tagged variant is skipped and numbering takes over.
   */
  base?: string
  /** Awaited with the source size before anything is written. */
  waitForSpace?: (bytes: number) => Promise<void>
  /** Opens the SOURCE for reading. Default `fs.createReadStream`. */
  openRead?: (p: string) => NodeJS.ReadableStream
  /** Hashes the temp file for the verification re-read. Default streaming SHA-256. */
  hashFile?: (p: string) => Promise<string>
  /** Hard-link primitive used to finalise temp -> final. Default `fs.link`. */
  linkFn?: (existingPath: string, newPath: string) => Promise<void>
  /** Stops the copy mid-file (rejects with `AbortError`); the incomplete temp is this call's own and is removed. */
  signal?: AbortSignal
}

/** Errors from `link` that mean "this volume has no hard links", not "something is wrong". */
const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'])
const MAX_NAME_ATTEMPTS = 1000
const MAX_TEMP_ATTEMPTS = 1000
const MAX_VANISH_RETRIES = 3

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as NodeJS.ErrnoException).code : undefined
}

function assertPlainName(what: string, name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    path.basename(name) !== name
  ) {
    throw new Error(`${what} must be a plain file name: ${JSON.stringify(name)}`)
  }
}

/** Streaming SHA-256 of a file (read-only). */
export async function sha256File(p: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(p)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * `C0001_gol.MP4` + tag `T` -> `C0001-T_gol.MP4` (same shape as `buildName`'s tagged head);
 * `C0001_TOP_gol.MP4` -> `C0001-T_TOP_gol.MP4`.
 */
function taggedName(desiredName: string, tag: string | undefined, base: string | undefined): string | undefined {
  if (tag === undefined || tag === '') return undefined
  assertPlainName('cameraTag', tag)
  const b = base ?? parseOriginalName(desiredName).base
  if (b === '' || !desiredName.startsWith(b)) return undefined
  const rest = desiredName.slice(b.length)
  if (rest !== '' && !rest.startsWith('_') && !rest.startsWith('.')) return undefined
  return `${b}-${tag}${rest}`
}

function* candidateNames(desiredName: string, tagged: string | undefined): Generator<string> {
  yield desiredName
  if (tagged !== undefined) yield tagged
  const numbered = tagged ?? desiredName
  for (let n = 2; n < MAX_NAME_ATTEMPTS; n++) yield withConflictSuffix(numbered, n)
}

class HashingCounter extends Transform {
  readonly hash = createHash('sha256')
  bytes = 0
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk)
    this.bytes += chunk.length
    cb(null, chunk)
  }
}

/** Writes the whole buffer at the handle's current position (`write` may be partial). */
async function writeAll(fh: fs.FileHandle, buf: Buffer): Promise<void> {
  let off = 0
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, null)
    if (bytesWritten === 0) throw new Error('write made no progress (0 bytes written)')
    off += bytesWritten
  }
}

/** Creates the temp file with `wx`; never touches a temp left behind by an earlier run. */
async function createTemp(destDir: string, desiredName: string): Promise<{ tempPath: string; fh: fs.FileHandle }> {
  for (let n = 0; n < MAX_TEMP_ATTEMPTS; n++) {
    const name = n === 0 ? `.${desiredName}.partial` : `.${desiredName}.${process.pid}-${n}.partial`
    const tempPath = path.join(destDir, name)
    try {
      return { tempPath, fh: await fs.open(tempPath, 'wx') }
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e
    }
  }
  throw new Error(`could not create a unique temp file for ${desiredName}`)
}

/** Removes the app's own temp from this call. Best effort: a leftover temp is harmless. */
async function removeOwnTemp(tempPath: string): Promise<void> {
  try {
    await fs.unlink(tempPath)
  } catch {
    // ignore
  }
}

type Claim = 'linked' | 'renamed' | 'exists'

/**
 * Gives the verified temp its final name without ever replacing an existing file.
 * Primary: hard link (fails with EEXIST if the name is taken). Fallback for volumes without
 * hard links: claim the name with an exclusive `open(final, 'wx')` placeholder, then rename
 * the temp over that empty placeholder (which this call created itself).
 */
async function claimFinalName(
  tempPath: string,
  finalPath: string,
  linkFn: (a: string, b: string) => Promise<void>,
): Promise<Claim> {
  try {
    await linkFn(tempPath, finalPath)
    return 'linked'
  } catch (e) {
    const code = errCode(e)
    if (code === 'EEXIST') return 'exists'
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw e
  }

  let placeholder: fs.FileHandle
  try {
    placeholder = await fs.open(finalPath, 'wx')
  } catch (e) {
    if (errCode(e) === 'EEXIST') return 'exists'
    throw e
  }
  let ino: number
  try {
    ino = (await placeholder.stat()).ino
  } finally {
    await placeholder.close()
  }
  // Only rename over the placeholder if it is still the empty file this call created.
  const st = await fs.lstat(finalPath)
  if (st.ino !== ino || st.size !== 0) {
    // Cannot prove the placeholder is still ours (e.g. unstable inode numbers on a virtual
    // volume). Do not try further names; leave the placeholder and the verified temp in place.
    throw new Error(
      `placeholder ${finalPath} changed identity before rename; left in place, verified temp kept at ${tempPath}`,
    )
  }
  try {
    await fs.rename(tempPath, finalPath)
  } catch (e) {
    // Undo our own claim: remove the placeholder only if it is still the empty file we created.
    try {
      const now = await fs.lstat(finalPath)
      if (now.ino === ino && now.size === 0) await fs.unlink(finalPath)
    } catch {
      // ignore
    }
    throw e
  }
  return 'renamed'
}

/** true / false, or 'gone' when the file disappeared between EEXIST and the check. */
async function holdsSameContent(p: string, sha256: string, size: number): Promise<boolean | 'gone'> {
  try {
    const st = await fs.lstat(p)
    if (!st.isFile() || st.size !== size) return false
    return (await sha256File(p)) === sha256
  } catch (e) {
    return errCode(e) === 'ENOENT' ? 'gone' : false
  }
}

/**
 * Copies `srcPath` into `destDir` as `desiredName` (add-only, verified).
 *
 * The source is streamed once through SHA-256 into a hidden temp file in `destDir`
 * (flag `wx`), fsynced, re-read and compared (hash and size). Only then does it get its final
 * name: `desiredName`, then the camera-tagged name, then ` (2)`, ` (3)`... Existing files are
 * never overwritten, moved or deleted; an existing file with identical content makes the
 * result `duplicate`. A temp that fails verification is left in place. Source read errors
 * reject with their original error (code intact).
 */
export async function copyVerified(
  srcPath: string,
  destDir: string,
  desiredName: string,
  opts: CopyOptions = {},
): Promise<CopyOutcome> {
  assertPlainName('desiredName', desiredName)
  const tagged = taggedName(desiredName, opts.cameraTag, opts.base)
  const openRead = opts.openRead ?? ((p: string): NodeJS.ReadableStream => createReadStream(p))
  const hashFile = opts.hashFile ?? sha256File
  const linkFn = opts.linkFn ?? ((a: string, b: string): Promise<void> => fs.link(a, b))

  const expectedSize = (await fs.stat(srcPath)).size
  await opts.waitForSpace?.(expectedSize)

  const { tempPath, fh } = await createTemp(destDir, desiredName)
  const counter = new HashingCounter()
  try {
    let primary: unknown
    let failed = false
    try {
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb): void {
          writeAll(fh, chunk).then(() => cb(), cb)
        },
      })
      await pipeline(openRead(srcPath), counter, sink, opts.signal ? { signal: opts.signal } : {})
      await fh.sync()
    } catch (e) {
      failed = true
      primary = e
    }
    try {
      await fh.close()
    } catch (closeErr) {
      // A close error must not replace the original (source) error and its code.
      if (!failed) throw closeErr
    }
    if (failed) throw primary
  } catch (e) {
    // Source (or write) failure: the temp is this call's own, incomplete file.
    await removeOwnTemp(tempPath)
    throw e
  }

  const sha256 = counter.hash.digest('hex')
  const bytes = counter.bytes
  if (bytes !== expectedSize) return { status: 'verify_failed', tempPath }
  const reread = await hashFile(tempPath)
  const tempSize = (await fs.stat(tempPath)).size
  if (reread !== sha256 || tempSize !== bytes) return { status: 'verify_failed', tempPath }

  let attempts = 0
  for (const name of candidateNames(desiredName, tagged)) {
    const finalPath = path.join(destDir, name)
    for (let vanished = 0; vanished <= MAX_VANISH_RETRIES; vanished++) {
      attempts++
      const claim = await claimFinalName(tempPath, finalPath, linkFn)
      if (claim === 'renamed') return { status: 'copied', destPath: finalPath, bytes, sha256 }
      if (claim === 'linked') {
        await removeOwnTemp(tempPath)
        return { status: 'copied', destPath: finalPath, bytes, sha256 }
      }
      const same = await holdsSameContent(finalPath, sha256, bytes)
      if (same === true) {
        await removeOwnTemp(tempPath)
        return { status: 'duplicate', destPath: finalPath, sha256 }
      }
      if (same === false) break
    }
  }
  throw new Error(`no free file name for ${desiredName} after ${attempts} attempts; temp kept at ${tempPath}`)
}
