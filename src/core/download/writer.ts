import { createHash, type Hash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { DriveError } from './drive'

/**
 * Add-only, verified writer. On the destination it only ever creates files. The only files it deletes or
 * replaces are its own: the partial `.<fileId>.partial` and its own empty placeholder during a name claim.
 * `.bad` files and everything else are never touched.
 */

export type WriteResult =
  | { status: 'written'; finalPath: string; bytes: number; md5: string }
  | { status: 'mismatch'; tempPath: string; bytes: number; md5: string }

export type WriteOptions = {
  /** Existing directory to write into (never created here). */
  dir: string
  /** Plain final file name inside `dir`. */
  name: string
  /** Drive file id; names the partial `.<fileId>.partial`. */
  fileId: string
  /** Drive `md5Checksum`; `null` for exports and files without one. */
  expectedMd5: string | null
  /** Drive `size`; `null` when unknown (exports). */
  expectedSize: number | null
  /** Opens the source from byte `fromByte` (a Range request when > 0). */
  open: (fromByte: number) => Promise<ReadableStream<Uint8Array>>
  /** Called after every written chunk with the total bytes of this file now in the partial. */
  onBytes?: (n: number) => void
  /** How many times a body that breaks off midway is reopened from the bytes on disk. Default 5. */
  maxResumes?: number
  /** Stops the write; the partial stays for a later resume and the call rejects with the signal's reason. */
  signal?: AbortSignal
  /** Hard-link primitive used to finalise. Default `fs.link`. Tests inject failures for no-hard-link volumes. */
  linkFn?: (existingPath: string, newPath: string) => Promise<void>
}

/** Errors from `link` that mean "this volume has no hard links" (e.g. exFAT), not "something is wrong". */
const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'])
const DEFAULT_MAX_RESUMES = 5
const MAX_BAD_NAMES = 1000
const HASH_READ_CHUNK = 1024 * 1024
/** Resume: read and append to the existing partial, never following a symlink at its name. */
const RESUME_FLAGS = fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW

const NOT_REGULAR_MESSAGE = 'dočasný soubor není běžný soubor'
const EXTRA_LINK_MESSAGE = 'dočasný soubor má další pevný odkaz'
/**
 * `DriveError('server')` statuses that mean "this Range request cannot be served" (drive.ts `checkRangeAnswer`:
 * 200 = Range ignored, 206 = wrong offset; 416 = range not satisfiable). Only these discard a partial; a 5xx or
 * 408 after the client's retries keeps it for a later resume.
 */
const RANGE_REJECTED_STATUSES = new Set([200, 206, 416])

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

function isAbort(e: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

/** An abort always surfaces as the abort (the signal's reason), whatever error it caused on the way. */
function surfaced(e: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted === true ? signal.reason : e
}

/**
 * A body that kept breaking off is a connection problem. Reading the source never touches the disk, so a read error
 * that carries an errno code (e.g. ECONNRESET) must not pass for a disk error: it is wrapped as
 * `DriveError('network')` (original as `cause`). A `DriveError` from the body stays as it is.
 */
function asNetworkError(e: unknown): DriveError {
  return e instanceof DriveError ? e : new DriveError('network', 'spojení se opakovaně přerušilo', null, { cause: e })
}

/** `<dir>/.<fileId>.partial` — the app's own temp for this Drive file. */
export function partialPath(dir: string, fileId: string): string {
  assertPlainName('fileId', fileId)
  return path.join(dir, `.${fileId}.partial`)
}

/** Size of the partial at `p` (`lstat`, symlinks not followed); 0 when missing; throws when it is not a regular file. */
export async function partialSize(p: string): Promise<number> {
  let st: Awaited<ReturnType<typeof fs.lstat>>
  try {
    st = await fs.lstat(p)
  } catch (e) {
    if (errCode(e) === 'ENOENT') return 0
    throw e
  }
  if (!st.isFile()) throw new Error(NOT_REGULAR_MESSAGE)
  return st.size
}

/** Writes the whole chunk at the handle's position (`write` may be partial; zero progress is an error). */
async function writeAll(fh: fs.FileHandle, buf: Uint8Array): Promise<void> {
  let off = 0
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, null)
    if (bytesWritten === 0) throw new Error('write made no progress (0 bytes written)')
    off += bytesWritten
  }
}

/** Removes the app's own temp. Best effort: a leftover temp is harmless. */
async function removeOwnTemp(tempPath: string): Promise<void> {
  try {
    await fs.unlink(tempPath)
  } catch {
    // ignore
  }
}

type Claim = 'linked' | 'renamed' | 'exists'

/**
 * Gives the verified temp its final name without ever replacing an existing file (or following a symlink there).
 * Primary: hard link (fails with EEXIST if the name is taken). Fallback for volumes without hard links: claim the
 * name with an exclusive `open(final, 'wx')` placeholder, then rename the temp over that empty placeholder, which
 * this call created itself. `'linked'` leaves the temp in place for the caller to remove.
 */
export async function claimFinalName(
  tempPath: string,
  finalPath: string,
  linkFn: (a: string, b: string) => Promise<void> = (a, b) => fs.link(a, b),
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
  if (!st.isFile() || st.ino !== ino || st.size !== 0) {
    // Cannot prove the placeholder is still ours (e.g. unstable inode numbers on a virtual volume).
    // Leave the placeholder and the verified temp in place.
    throw new Error(`placeholder ${finalPath} changed identity before rename; left in place, verified temp kept at ${tempPath}`)
  }
  try {
    await fs.rename(tempPath, finalPath)
  } catch (e) {
    // Undo our own claim: remove the placeholder only if it is still the empty file we created.
    try {
      const now = await fs.lstat(finalPath)
      if (now.isFile() && now.ino === ino && now.size === 0) await fs.unlink(finalPath)
    } catch {
      // ignore
    }
    throw e
  }
  return 'renamed'
}

/** The open partial: handle, its inode, and the running MD5 over every byte in it. */
type OpenPartial = { fh: fs.FileHandle; ino: number; hash: Hash; bytes: number }

async function createFresh(tempPath: string): Promise<OpenPartial> {
  // `wx`: never clobbers anything, not even a symlink at the name.
  const fh = await fs.open(tempPath, 'wx')
  try {
    const st = await fh.stat()
    return { fh, ino: st.ino, hash: createHash('md5'), bytes: 0 }
  } catch (e) {
    await fh.close().catch(() => undefined)
    throw e
  }
}

/**
 * Opens an existing partial for append and hashes the bytes already in it. A partial with a second hard link
 * (e.g. the app died between linking the final name and removing the partial) shares its bytes with another
 * name: only the partial's own name is removed and a fresh one is created, so the other file is never written.
 */
async function openForResume(tempPath: string, signal: AbortSignal | undefined): Promise<OpenPartial> {
  let fh: fs.FileHandle
  try {
    fh = await fs.open(tempPath, RESUME_FLAGS)
  } catch (e) {
    if (errCode(e) === 'ELOOP') throw new Error(NOT_REGULAR_MESSAGE)
    throw e
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new Error(NOT_REGULAR_MESSAGE)
    if (st.nlink !== 1) {
      await fh.close()
      await unlinkOwnPartial(tempPath, st.ino)
      return createFresh(tempPath)
    }
    const hash = createHash('md5')
    const buf = Buffer.allocUnsafe(HASH_READ_CHUNK)
    let pos = 0
    while (pos < st.size) {
      signal?.throwIfAborted()
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos)
      if (bytesRead === 0) throw new Error('dočasný soubor se při čtení zkrátil')
      hash.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    return { fh, ino: st.ino, hash, bytes: st.size }
  } catch (e) {
    await fh.close().catch(() => undefined)
    throw e
  }
}

/** Deletes the partial only if it is still a regular file (and, when known, the very file we had open). */
async function unlinkOwnPartial(tempPath: string, ino: number | null): Promise<void> {
  const st = await fs.lstat(tempPath)
  if (!st.isFile()) throw new Error(NOT_REGULAR_MESSAGE)
  if (ino !== null && st.ino !== ino) throw new Error('dočasný soubor se během stahování změnil')
  await fs.unlink(tempPath)
}

/** Opens the partial for this download: resumes it when the result can still be verified, else starts afresh. */
async function openPartial(tempPath: string, canResume: boolean, signal: AbortSignal | undefined): Promise<OpenPartial> {
  let st: Awaited<ReturnType<typeof fs.lstat>>
  try {
    st = await fs.lstat(tempPath)
  } catch (e) {
    if (errCode(e) === 'ENOENT') return createFresh(tempPath)
    throw e
  }
  // A directory or symlink at the partial's name is not ours to touch.
  if (!st.isFile()) throw new Error(NOT_REGULAR_MESSAGE)
  if (canResume) return openForResume(tempPath, signal)
  // No MD5 to check the joined bytes against (exports, files without md5Checksum): appending could pass a
  // corrupt file as good, so the app's own partial is discarded and the download starts from 0.
  await unlinkOwnPartial(tempPath, null)
  return createFresh(tempPath)
}

/** Discards the app's own partial and recreates it empty (`wx`). */
async function restartPartial(tempPath: string, part: OpenPartial): Promise<OpenPartial> {
  await part.fh.close()
  await unlinkOwnPartial(tempPath, part.ino)
  return createFresh(tempPath)
}

/**
 * Copies the stream into the partial. Resolves `null` when the stream ended, `{ error }` when reading the
 * stream failed (worth a resume). Write errors and an abort reject.
 */
async function pump(
  stream: ReadableStream<Uint8Array>,
  part: OpenPartial,
  signal: AbortSignal | undefined,
  onBytes: ((n: number) => void) | undefined,
): Promise<{ error: unknown } | null> {
  const reader = stream.getReader()
  // Cancelling ends a pending read (as `done`); the abort check after every read turns that into the abort.
  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  let settled = false
  try {
    signal?.throwIfAborted()
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error) {
        settled = true
        return { error }
      }
      signal?.throwIfAborted()
      if (chunk.done) {
        settled = true
        return null
      }
      if (chunk.value.byteLength === 0) continue
      await writeAll(part.fh, chunk.value)
      part.hash.update(chunk.value)
      part.bytes += chunk.value.byteLength
      onBytes?.(part.bytes)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Release the connection when we stop early (write error, abort).
    if (!settled) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Refuses to give the partial another name when it is not exactly our single-linked file `ino`. */
async function assertSingleLink(tempPath: string, ino: number): Promise<void> {
  const st = await fs.lstat(tempPath)
  if (!st.isFile() || st.ino !== ino) throw new Error('dočasný soubor se během stahování změnil')
  if (st.nlink !== 1) throw new Error(EXTRA_LINK_MESSAGE)
}

/** Moves the partial to `.<fileId>.bad`, `.bad.2`, `.bad.3`, ... — never replacing an existing file. */
async function keepAsBad(
  dir: string,
  fileId: string,
  tempPath: string,
  ino: number,
  linkFn: (a: string, b: string) => Promise<void>,
): Promise<string> {
  await assertSingleLink(tempPath, ino)
  for (let n = 1; n <= MAX_BAD_NAMES; n++) {
    const badPath = path.join(dir, n === 1 ? `.${fileId}.bad` : `.${fileId}.bad.${n}`)
    const claim = await claimFinalName(tempPath, badPath, linkFn)
    if (claim === 'linked') await removeOwnTemp(tempPath)
    if (claim !== 'exists') return badPath
  }
  throw new Error(`no free .bad name for ${fileId}; partial kept at ${tempPath}`)
}

/**
 * Downloads one file into `.<fileId>.partial` in `dir` (resuming a partial left by an earlier run), verifies
 * it (size and MD5 when known, else non-empty) and only then gives it its final name `name`, add-only.
 *
 * - A body that breaks off is reopened from the current partial size, up to `maxResumes` times; then the read error
 *   is thrown as `DriveError('network')` (a `DriveError` from the body as it is).
 * - Resuming needs `expectedMd5`; without it, or for a partial with a second hard link, the partial is recreated.
 * - A partial that already has `expectedSize` bytes is verified without opening the source.
 * - `DriveError('server')` with a Range-specific status (200/206/416) on a resume: the partial is recreated, from 0.
 *   A 5xx/408 is rethrown and the partial kept.
 * - Other `DriveError`s and an abort are rethrown at once; the partial stays for a later resume.
 * - Mismatch → the bytes are kept as `.<fileId>.bad` (or `.bad.2`, ...) and `mismatch` is returned.
 * - Final name taken → throws `cíl už existuje`; the existing file is never touched.
 */
export async function writeVerified(opts: WriteOptions): Promise<WriteResult> {
  assertPlainName('name', opts.name)
  const tempPath = partialPath(opts.dir, opts.fileId)
  const finalPath = path.join(opts.dir, opts.name)
  const maxResumes = opts.maxResumes ?? DEFAULT_MAX_RESUMES
  if (!Number.isInteger(maxResumes) || maxResumes < 0) {
    throw new RangeError(`maxResumes must be a finite integer >= 0, got ${maxResumes}`)
  }
  const linkFn = opts.linkFn ?? ((a: string, b: string): Promise<void> => fs.link(a, b))
  const { signal, expectedMd5, expectedSize } = opts
  signal?.throwIfAborted()
  // Only an MD5 can prove that bytes appended to an old partial are right; without one a download restarts instead.
  const canResume = expectedMd5 !== null

  let part = await openPartial(tempPath, canResume, signal)
  let diskSize = -1
  let failed = false
  let primary: unknown
  try {
    if (part.bytes > 0) opts.onBytes?.(part.bytes)
    let resumes = 0
    for (;;) {
      signal?.throwIfAborted()
      // The partial already holds every byte (e.g. a crash after the last fsync): verify without asking for more.
      if (expectedSize !== null && part.bytes > 0 && part.bytes === expectedSize) break
      let stream: ReadableStream<Uint8Array>
      try {
        stream = await opts.open(part.bytes)
      } catch (e) {
        if (
          part.bytes > 0 &&
          !isAbort(e, signal) &&
          e instanceof DriveError &&
          e.kind === 'server' &&
          e.status !== null &&
          RANGE_REJECTED_STATUSES.has(e.status)
        ) {
          part = await restartPartial(tempPath, part)
          continue
        }
        throw surfaced(e, signal)
      }
      const broke = await pump(stream, part, signal, opts.onBytes)
      if (broke === null) break
      const e = broke.error
      if (isAbort(e, signal) || (e instanceof DriveError && e.kind !== 'server')) throw surfaced(e, signal)
      if (resumes >= maxResumes) throw asNetworkError(e)
      resumes++
      if (canResume) {
        await part.fh.sync()
        const onDisk = (await part.fh.stat()).size
        if (onDisk !== part.bytes) throw new Error('dočasný soubor nemá očekávanou velikost')
      } else {
        part = await restartPartial(tempPath, part)
      }
    }
    await part.fh.sync()
    diskSize = (await part.fh.stat()).size
  } catch (e) {
    failed = true
    primary = e
  }
  try {
    await part.fh.close()
  } catch (closeErr) {
    // A close error must not replace the original error.
    if (!failed) throw closeErr
  }
  if (failed) throw primary

  const bytes = part.bytes
  const md5 = part.hash.digest('hex')
  const verified =
    diskSize === bytes &&
    (expectedSize === null || bytes === expectedSize) &&
    (expectedMd5 === null || md5 === expectedMd5.toLowerCase()) &&
    (expectedMd5 !== null || expectedSize !== null || bytes > 0)
  if (!verified) {
    return { status: 'mismatch', tempPath: await keepAsBad(opts.dir, opts.fileId, tempPath, part.ino, linkFn), bytes, md5 }
  }

  await assertSingleLink(tempPath, part.ino)
  const claim = await claimFinalName(tempPath, finalPath, linkFn)
  if (claim === 'exists') throw new Error('cíl už existuje')
  if (claim === 'linked') await removeOwnTemp(tempPath)
  return { status: 'written', finalPath, bytes, md5 }
}
