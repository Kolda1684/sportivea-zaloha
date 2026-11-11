import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DriveError } from '../../../src/core/download/drive'
import { claimFinalName, partialPath, partialSize, writeVerified } from '../../../src/core/download/writer'

const MB = 1024 * 1024
const FILE_ID = '1AbCdEfGhIjKlMnOp'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'writer-test-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex')

const errCode = (code: string): Error => Object.assign(new Error(code), { code })

/**
 * A Web stream over `buf` in chunks of `chunkSize`. With `errorAfter`, it delivers exactly that many bytes
 * and then errors (like a connection that breaks off mid-body).
 */
function streamOf(buf: Buffer, opts: { chunkSize?: number; errorAfter?: number } = {}): ReadableStream<Uint8Array> {
  const chunkSize = opts.chunkSize ?? 64 * 1024
  const limit = opts.errorAfter ?? buf.length
  let pos = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= limit) {
        if (opts.errorAfter !== undefined) controller.error(new TypeError('terminated'))
        else controller.close()
        return
      }
      const end = Math.min(pos + chunkSize, limit)
      controller.enqueue(new Uint8Array(buf.subarray(pos, end)))
      pos = end
    },
  })
}

/** `open` callback that serves `data` from the requested offset and records the offsets. */
function server(data: Buffer, plan: { errorAfter?: number }[] = []): {
  calls: number[]
  open: (fromByte: number) => Promise<ReadableStream<Uint8Array>>
} {
  const calls: number[] = []
  return {
    calls,
    open: (fromByte) => {
      const step = plan[calls.length] ?? {}
      calls.push(fromByte)
      const rest = data.subarray(fromByte)
      return Promise.resolve(streamOf(rest, step.errorAfter === undefined ? {} : { errorAfter: step.errorAfter }))
    },
  }
}

const exists = async (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false,
  )

describe('partialPath / partialSize', () => {
  it('names the partial by file id only', () => {
    expect(partialPath('/x/y', FILE_ID)).toBe(`/x/y/.${FILE_ID}.partial`)
  })

  it('returns 0 for a missing partial and the size of an existing one', async () => {
    const p = partialPath(dir, FILE_ID)
    expect(await partialSize(p)).toBe(0)
    await fs.writeFile(p, Buffer.alloc(1234))
    expect(await partialSize(p)).toBe(1234)
  })

  it('refuses a partial that is not a regular file', async () => {
    const p = partialPath(dir, FILE_ID)
    await fs.mkdir(p)
    await expect(partialSize(p)).rejects.toThrow('dočasný soubor není běžný soubor')
  })
})

describe('writeVerified', () => {
  it('writes a fresh 3 MB file and verifies it', async () => {
    const data = randomBytes(3 * MB)
    const srv = server(data)
    const seen: number[] = []
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: srv.open,
      onBytes: (n) => seen.push(n),
    })
    expect(res).toEqual({ status: 'written', finalPath: path.join(dir, 'clip.mp4'), bytes: data.length, md5: md5(data) })
    expect((await fs.readFile(path.join(dir, 'clip.mp4'))).equals(data)).toBe(true)
    expect(await exists(partialPath(dir, FILE_ID))).toBe(false)
    expect(srv.calls).toEqual([0])
    expect(seen.at(-1)).toBe(data.length)
    expect(await fs.readdir(dir)).toEqual(['clip.mp4'])
  })

  it('resumes a partial with Range', async () => {
    const data = randomBytes(3 * MB)
    await fs.writeFile(partialPath(dir, FILE_ID), data.subarray(0, MB))
    const srv = server(data)
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: srv.open,
    })
    expect(srv.calls).toEqual([1048576])
    expect(res).toMatchObject({ status: 'written', md5: md5(data), bytes: data.length })
    expect((await fs.readFile(path.join(dir, 'clip.mp4'))).equals(data)).toBe(true)
    expect(await exists(partialPath(dir, FILE_ID))).toBe(false)
  })

  it('resumes from the bytes on disk after the stream breaks off', async () => {
    const data = randomBytes(2 * MB)
    const srv = server(data, [{ errorAfter: 512000 }])
    const sizesAtOpen: number[] = []
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: async (from) => {
        sizesAtOpen.push(await partialSize(partialPath(dir, FILE_ID)))
        return srv.open(from)
      },
    })
    expect(srv.calls).toEqual([0, 512000])
    expect(sizesAtOpen).toEqual([0, 512000])
    expect(res.status).toBe('written')
    expect((await fs.readFile(path.join(dir, 'clip.mp4'))).equals(data)).toBe(true)
  })

  it('gives up after maxResumes with a network DriveError (cause kept) and keeps the partial', async () => {
    const data = randomBytes(MB)
    const srv = server(data, [{ errorAfter: 1000 }, { errorAfter: 1000 }, { errorAfter: 1000 }])
    const error = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: srv.open,
      maxResumes: 2,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriveError)
    expect(error).toMatchObject({ kind: 'network' })
    expect((error as Error).cause).toBeInstanceOf(TypeError)
    expect(srv.calls).toEqual([0, 1000, 2000])
    expect(await partialSize(partialPath(dir, FILE_ID))).toBe(3000)
    expect(await exists(path.join(dir, 'clip.mp4'))).toBe(false)
  })

  it('never reports a read error with an errno code as a disk error: it becomes a network DriveError', async () => {
    const data = randomBytes(4096)
    const reset = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
        },
      })
    const error = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: () => Promise.resolve(reset()),
      maxResumes: 0,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriveError)
    expect(error).toMatchObject({ kind: 'network' })
    expect(Object.hasOwn(error as object, 'code')).toBe(false)
  })

  it('keeps a Drive server error from the body as it is after maxResumes', async () => {
    const data = randomBytes(4096)
    const broken = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new DriveError('server', 'x', 503))
        },
      })
    const error = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: () => Promise.resolve(broken()),
      maxResumes: 1,
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'server', status: 503 })
  })

  it('restarts from 0 when the server cannot honour Range', async () => {
    const data = randomBytes(MB)
    await fs.writeFile(partialPath(dir, FILE_ID), Buffer.alloc(300_000, 7))
    const calls: number[] = []
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: (from) => {
        calls.push(from)
        if (from > 0) return Promise.reject(new DriveError('server', 'Google Disk ignoroval žádost o pokračování stahování', 200))
        return Promise.resolve(streamOf(data))
      },
    })
    expect(calls).toEqual([300_000, 0])
    expect(res).toMatchObject({ status: 'written', md5: md5(data) })
    expect((await fs.readFile(path.join(dir, 'clip.mp4'))).equals(data)).toBe(true)
  })

  it.each([
    ['Range ignored (200)', 200],
    ['wrong offset (206)', 206],
    ['range not satisfiable (416)', 416],
  ])('restarts from 0 for a Range-specific server answer: %s', async (_label, status) => {
    const data = randomBytes(1000)
    await fs.writeFile(partialPath(dir, FILE_ID), Buffer.alloc(300, 7))
    const calls: number[] = []
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: (from) => {
        calls.push(from)
        if (from > 0) return Promise.reject(new DriveError('server', 'range', status))
        return Promise.resolve(streamOf(data))
      },
    })
    expect(calls).toEqual([300, 0])
    expect(res).toMatchObject({ status: 'written', md5: md5(data) })
  })

  it.each([503, 500, 408])('keeps a resumable partial when the server fails with %i', async (status) => {
    const data = randomBytes(2 * MB)
    await fs.writeFile(partialPath(dir, FILE_ID), data.subarray(0, MB))
    const calls: number[] = []
    const err = new DriveError('server', 'Google Disk teď neodpovídá', status)
    const error = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: (from) => {
        calls.push(from)
        return Promise.reject(err)
      },
    }).catch((e: unknown) => e)
    expect(error).toBe(err)
    expect(calls).toEqual([MB])
    expect(await partialSize(partialPath(dir, FILE_ID))).toBe(MB)
    expect((await fs.readFile(partialPath(dir, FILE_ID))).equals(data.subarray(0, MB))).toBe(true)
  })

  it('never resumes into a partial that is hard-linked to another file', async () => {
    const data = randomBytes(2 * MB)
    const other = path.join(dir, 'A.mp4')
    const otherBytes = data.subarray(0, MB)
    await fs.writeFile(other, otherBytes)
    await fs.link(other, partialPath(dir, FILE_ID))
    const srv = server(data)
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: srv.open,
    })
    expect(srv.calls).toEqual([0])
    expect(res).toMatchObject({ status: 'written', bytes: data.length, md5: md5(data) })
    expect((await fs.readFile(path.join(dir, 'clip.mp4'))).equals(data)).toBe(true)
    expect((await fs.readFile(other)).equals(otherBytes)).toBe(true)
    expect((await fs.stat(other)).nlink).toBe(1)
    expect(await exists(partialPath(dir, FILE_ID))).toBe(false)
  })

  it('does not finalise or keep as .bad a partial that got a second hard link meanwhile', async () => {
    const data = randomBytes(1000)
    const other = path.join(dir, 'other.bin')
    for (const expectedMd5 of [md5(data), md5(Buffer.from('x'))]) {
      await expect(
        writeVerified({
          dir,
          name: 'clip.mp4',
          fileId: FILE_ID,
          expectedMd5,
          expectedSize: data.length,
          open: async (from) => {
            await fs.link(partialPath(dir, FILE_ID), other)
            return server(data).open(from)
          },
        }),
      ).rejects.toThrow('dočasný soubor má další pevný odkaz')
      expect(await exists(path.join(dir, 'clip.mp4'))).toBe(false)
      expect(await exists(path.join(dir, `.${FILE_ID}.bad`))).toBe(false)
      expect((await fs.readFile(other)).equals(data)).toBe(true)
      await fs.unlink(other)
      await fs.unlink(partialPath(dir, FILE_ID))
    }
  })

  it('verifies a complete partial without opening the source', async () => {
    const data = randomBytes(MB)
    await fs.writeFile(partialPath(dir, FILE_ID), data)
    const srv = server(data)
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: srv.open,
    })
    expect(srv.calls).toEqual([])
    expect(res).toEqual({ status: 'written', finalPath: path.join(dir, 'clip.mp4'), bytes: data.length, md5: md5(data) })
    expect(await exists(partialPath(dir, FILE_ID))).toBe(false)
  })

  it('does not resume when only the size is known: restarts with a fresh partial', async () => {
    const data = randomBytes(1000)
    await fs.writeFile(partialPath(dir, FILE_ID), Buffer.alloc(400, 9))
    const srv = server(data, [{ errorAfter: 300 }])
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: null,
      expectedSize: data.length,
      open: srv.open,
    })
    expect(srv.calls).toEqual([0, 0])
    expect(res).toMatchObject({ status: 'written', bytes: 1000 })
    expect((await fs.readFile(path.join(dir, 'clip.mp4'))).equals(data)).toBe(true)
  })

  it('rethrows other Drive errors at once and keeps the partial', async () => {
    const data = randomBytes(MB)
    await fs.writeFile(partialPath(dir, FILE_ID), data.subarray(0, 1000))
    const calls: number[] = []
    const err = new DriveError('not_found', 'soubor na Google Disku už neexistuje', 404)
    const error = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: (from) => {
        calls.push(from)
        return Promise.reject(err)
      },
    }).catch((e: unknown) => e)
    expect(error).toBe(err)
    expect(calls).toEqual([1000])
    expect((await fs.readFile(partialPath(dir, FILE_ID))).equals(data.subarray(0, 1000))).toBe(true)
  })

  it('surfaces an abort as the abort, without retrying, and keeps the partial', async () => {
    const data = randomBytes(MB)
    const controller = new AbortController()
    const calls: number[] = []
    const error = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      signal: controller.signal,
      open: (from) => {
        calls.push(from)
        let pos = 0
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (pos >= 200_000) {
                controller.abort()
                // A body that is never finished: only the abort can end the read.
                return new Promise<void>(() => undefined)
              }
              c.enqueue(new Uint8Array(data.subarray(pos, pos + 100_000)))
              pos += 100_000
              return undefined
            },
          }, new CountQueuingStrategy({ highWaterMark: 0 })), // pull only when read
        )
      },
    }).catch((e: unknown) => e)
    expect(error).toBe(controller.signal.reason)
    expect(calls).toEqual([0])
    expect(await partialSize(partialPath(dir, FILE_ID))).toBe(200_000)
  })

  it('reports a md5 mismatch, keeps the bytes as .bad and leaves the final name free', async () => {
    const data = randomBytes(MB)
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(Buffer.from('something else')),
      expectedSize: data.length,
      open: server(data).open,
    })
    const bad = path.join(dir, `.${FILE_ID}.bad`)
    expect(res).toEqual({ status: 'mismatch', tempPath: bad, bytes: data.length, md5: md5(data) })
    expect(await exists(path.join(dir, 'clip.mp4'))).toBe(false)
    expect(await exists(partialPath(dir, FILE_ID))).toBe(false)
    expect((await fs.readFile(bad)).equals(data)).toBe(true)
  })

  it('never replaces an earlier .bad', async () => {
    const data = randomBytes(1000)
    const bad = path.join(dir, `.${FILE_ID}.bad`)
    const bad2 = path.join(dir, `.${FILE_ID}.bad.2`)
    await fs.writeFile(bad, 'earlier bad')
    await fs.writeFile(bad2, 'earlier bad 2')
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(Buffer.from('x')),
      expectedSize: null,
      open: server(data).open,
    })
    expect(res).toMatchObject({ status: 'mismatch', tempPath: path.join(dir, `.${FILE_ID}.bad.3`) })
    expect(await fs.readFile(bad, 'utf8')).toBe('earlier bad')
    expect(await fs.readFile(bad2, 'utf8')).toBe('earlier bad 2')
  })

  it('reports a size mismatch', async () => {
    const data = randomBytes(1000)
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: 999,
      open: server(data).open,
    })
    expect(res.status).toBe('mismatch')
    expect(await exists(path.join(dir, 'clip.mp4'))).toBe(false)
  })

  it('throws when the final name already exists and leaves that file byte-identical', async () => {
    const data = randomBytes(MB)
    const foreign = randomBytes(5000)
    const finalPath = path.join(dir, 'clip.mp4')
    await fs.writeFile(finalPath, foreign)
    const before = await fs.stat(finalPath)
    await expect(
      writeVerified({
        dir,
        name: 'clip.mp4',
        fileId: FILE_ID,
        expectedMd5: md5(data),
        expectedSize: data.length,
        open: server(data).open,
      }),
    ).rejects.toThrow('cíl už existuje')
    expect((await fs.readFile(finalPath)).equals(foreign)).toBe(true)
    const after = await fs.stat(finalPath)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('also refuses a final name that is a symlink, without following it', async () => {
    const data = randomBytes(1000)
    const target = path.join(dir, 'target.txt')
    await fs.writeFile(target, 'target')
    await fs.symlink(target, path.join(dir, 'clip.mp4'))
    await expect(
      writeVerified({
        dir,
        name: 'clip.mp4',
        fileId: FILE_ID,
        expectedMd5: md5(data),
        expectedSize: data.length,
        open: server(data).open,
        linkFn: () => Promise.reject(errCode('ENOTSUP')),
      }),
    ).rejects.toThrow('cíl už existuje')
    expect(await fs.readFile(target, 'utf8')).toBe('target')
    expect((await fs.lstat(path.join(dir, 'clip.mp4'))).isSymbolicLink()).toBe(true)
  })

  it('verifies only the size for an export with known size', async () => {
    const data = randomBytes(1000)
    const ok = await writeVerified({
      dir,
      name: 'a.docx',
      fileId: FILE_ID,
      expectedMd5: null,
      expectedSize: 1000,
      open: server(data).open,
    })
    expect(ok).toMatchObject({ status: 'written', bytes: 1000, md5: md5(data) })
    const bad = await writeVerified({
      dir,
      name: 'b.docx',
      fileId: 'otherFileId123',
      expectedMd5: null,
      expectedSize: 1001,
      open: server(data).open,
    })
    expect(bad.status).toBe('mismatch')
  })

  it('accepts any non-empty export of unknown size', async () => {
    const data = randomBytes(1000)
    const res = await writeVerified({
      dir,
      name: 'a.docx',
      fileId: FILE_ID,
      expectedMd5: null,
      expectedSize: null,
      open: server(data).open,
    })
    expect(res).toMatchObject({ status: 'written', bytes: 1000 })
    expect((await fs.readFile(path.join(dir, 'a.docx'))).equals(data)).toBe(true)
  })

  it('rejects an empty export of unknown size', async () => {
    const res = await writeVerified({
      dir,
      name: 'a.docx',
      fileId: FILE_ID,
      expectedMd5: null,
      expectedSize: null,
      open: server(Buffer.alloc(0)).open,
    })
    expect(res).toMatchObject({ status: 'mismatch', bytes: 0 })
    expect(await exists(path.join(dir, 'a.docx'))).toBe(false)
  })

  it('never appends to a partial it cannot verify: restarts an unverifiable download from 0', async () => {
    const data = randomBytes(1000)
    await fs.writeFile(partialPath(dir, FILE_ID), Buffer.alloc(500, 1))
    const srv = server(data, [{ errorAfter: 300 }])
    const res = await writeVerified({
      dir,
      name: 'a.docx',
      fileId: FILE_ID,
      expectedMd5: null,
      expectedSize: null,
      open: srv.open,
    })
    expect(srv.calls).toEqual([0, 0])
    expect(res).toMatchObject({ status: 'written', bytes: 1000 })
    expect((await fs.readFile(path.join(dir, 'a.docx'))).equals(data)).toBe(true)
  })

  it('refuses a partial that is a directory or a symlink and leaves it alone', async () => {
    const data = randomBytes(1000)
    const opts = {
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: server(data).open,
    }
    const p = partialPath(dir, FILE_ID)
    await fs.mkdir(p)
    await expect(writeVerified(opts)).rejects.toThrow('dočasný soubor není běžný soubor')
    expect((await fs.lstat(p)).isDirectory()).toBe(true)
    await fs.rmdir(p)

    const target = path.join(dir, 'target.bin')
    await fs.writeFile(target, 'keep me')
    await fs.symlink(target, p)
    await expect(writeVerified(opts)).rejects.toThrow('dočasný soubor není běžný soubor')
    expect(await fs.readFile(target, 'utf8')).toBe('keep me')
    expect((await fs.lstat(p)).isSymbolicLink()).toBe(true)
  })

  it('finalises by rename on a volume without hard links', async () => {
    const data = randomBytes(MB)
    let linkCalls = 0
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(data),
      expectedSize: data.length,
      open: server(data).open,
      linkFn: () => {
        linkCalls++
        return Promise.reject(errCode('ENOTSUP'))
      },
    })
    expect(linkCalls).toBe(1)
    expect(res).toMatchObject({ status: 'written', finalPath: path.join(dir, 'clip.mp4') })
    expect((await fs.readFile(path.join(dir, 'clip.mp4'))).equals(data)).toBe(true)
    expect(await fs.readdir(dir)).toEqual(['clip.mp4'])
  })

  it('keeps the .bad without hard links too', async () => {
    const data = randomBytes(1000)
    await fs.writeFile(path.join(dir, `.${FILE_ID}.bad`), 'earlier')
    const res = await writeVerified({
      dir,
      name: 'clip.mp4',
      fileId: FILE_ID,
      expectedMd5: md5(Buffer.from('x')),
      expectedSize: null,
      open: server(data).open,
      linkFn: () => Promise.reject(errCode('ENOTSUP')),
    })
    expect(res).toMatchObject({ status: 'mismatch', tempPath: path.join(dir, `.${FILE_ID}.bad.2`) })
    expect(await fs.readFile(path.join(dir, `.${FILE_ID}.bad`), 'utf8')).toBe('earlier')
    expect((await fs.readFile(path.join(dir, `.${FILE_ID}.bad.2`))).equals(data)).toBe(true)
    expect(await exists(partialPath(dir, FILE_ID))).toBe(false)
  })

  it('does not create the parent directory', async () => {
    const data = randomBytes(10)
    await expect(
      writeVerified({
        dir: path.join(dir, 'missing'),
        name: 'clip.mp4',
        fileId: FILE_ID,
        expectedMd5: md5(data),
        expectedSize: 10,
        open: server(data).open,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('rejects names that are not plain file names', async () => {
    const data = randomBytes(10)
    const base = { dir, expectedMd5: md5(data), expectedSize: 10, open: server(data).open }
    await expect(writeVerified({ ...base, name: '../x', fileId: FILE_ID })).rejects.toThrow()
    await expect(writeVerified({ ...base, name: 'x', fileId: 'a/b' })).rejects.toThrow()
    expect(await fs.readdir(dir)).toEqual([])
  })
})

describe('claimFinalName', () => {
  it('links when hard links work', async () => {
    const temp = path.join(dir, '.t.partial')
    await fs.writeFile(temp, 'data')
    expect(await claimFinalName(temp, path.join(dir, 'final'))).toBe('linked')
    expect(await fs.readFile(path.join(dir, 'final'), 'utf8')).toBe('data')
  })

  it('renames over its own placeholder when link is unsupported', async () => {
    const temp = path.join(dir, '.t.partial')
    await fs.writeFile(temp, 'data')
    const final = path.join(dir, 'final')
    expect(await claimFinalName(temp, final, () => Promise.reject(errCode('ENOTSUP')))).toBe('renamed')
    expect(await fs.readFile(final, 'utf8')).toBe('data')
    expect(await exists(temp)).toBe(false)
  })

  it('reports exists and touches nothing when the name is taken', async () => {
    const temp = path.join(dir, '.t.partial')
    const final = path.join(dir, 'final')
    await fs.writeFile(temp, 'data')
    await fs.writeFile(final, 'foreign')
    expect(await claimFinalName(temp, final)).toBe('exists')
    expect(await claimFinalName(temp, final, () => Promise.reject(errCode('ENOTSUP')))).toBe('exists')
    expect(await fs.readFile(final, 'utf8')).toBe('foreign')
    expect(await fs.readFile(temp, 'utf8')).toBe('data')
  })

  it('rethrows unexpected link errors without touching anything', async () => {
    const temp = path.join(dir, '.t.partial')
    await fs.writeFile(temp, 'data')
    await expect(claimFinalName(temp, path.join(dir, 'final'), () => Promise.reject(errCode('EIO')))).rejects.toThrow('EIO')
    expect(await fs.readdir(dir)).toEqual(['.t.partial'])
  })

  it('removes its own placeholder when the rename fails', async () => {
    const final = path.join(dir, 'final')
    const missingTemp = path.join(dir, '.gone.partial')
    await expect(claimFinalName(missingTemp, final, () => Promise.reject(errCode('ENOTSUP')))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await exists(final)).toBe(false)
  })
})
