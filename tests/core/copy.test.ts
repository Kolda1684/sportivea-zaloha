import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import * as fs from 'node:fs/promises'
import fsDefault from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyVerified, sha256File } from '../../src/core/copy'
import { makeSpaceWaiter } from '../../src/core/diskspace'

let root: string
let srcDir: string
let destDir: string

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

async function write(p: string, content: Buffer | string): Promise<string> {
  await fs.writeFile(p, content)
  return p
}

async function names(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort()
}

function fsError(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`${code}: simulated`)
  e.code = code
  return e
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'trideni-copy-'))
  srcDir = path.join(root, 'card')
  destDir = path.join(root, 'drive')
  await fs.mkdir(srcDir)
  await fs.mkdir(destDir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await fs.rm(root, { recursive: true, force: true })
})

describe('copyVerified', () => {
  it('copies to an empty folder and leaves no partial file', async () => {
    const data = Buffer.alloc(3_000_000, 7)
    const src = await write(path.join(srcDir, 'C0001.MP4'), data)
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4')
    expect(r).toEqual({
      status: 'copied',
      destPath: path.join(destDir, 'C0001_gol.MP4'),
      bytes: data.length,
      sha256: sha(data),
    })
    expect((await fs.readFile(path.join(destDir, 'C0001_gol.MP4'))).equals(data)).toBe(true)
    expect(await names(destDir)).toEqual(['C0001_gol.MP4'])
  })

  it('copies an empty file', async () => {
    const src = await write(path.join(srcDir, 'C0002.MP4'), '')
    const r = await copyVerified(src, destDir, 'C0002_x.MP4')
    expect(r.status).toBe('copied')
    expect(await names(destDir)).toEqual(['C0002_x.MP4'])
  })

  it('reports duplicate when the same content already sits under the name', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage-A')
    await copyVerified(src, destDir, 'C0001_gol.MP4')
    const again = await copyVerified(src, destDir, 'C0001_gol.MP4')
    expect(again).toEqual({
      status: 'duplicate',
      destPath: path.join(destDir, 'C0001_gol.MP4'),
      sha256: sha('footage-A'),
    })
    expect(await names(destDir)).toEqual(['C0001_gol.MP4'])
  })

  it('reports duplicate when the same content sits under the tagged name', async () => {
    await write(path.join(destDir, 'C0001_gol.MP4'), 'other camera')
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'mine')
    const first = await copyVerified(src, destDir, 'C0001_gol.MP4', { cameraTag: 'ILCE7M4' })
    expect(first.status).toBe('copied')
    const again = await copyVerified(src, destDir, 'C0001_gol.MP4', { cameraTag: 'ILCE7M4' })
    expect(again).toMatchObject({
      status: 'duplicate',
      destPath: path.join(destDir, 'C0001-ILCE7M4_gol.MP4'),
    })
    expect(await names(destDir)).toEqual(['C0001-ILCE7M4_gol.MP4', 'C0001_gol.MP4'])
  })

  it('inserts the camera tag after the base when the name holds different content', async () => {
    const existing = await write(path.join(destDir, 'C0001_gol.MP4'), 'older clip')
    const before = await sha256File(existing)
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'newer clip')
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4', { cameraTag: 'ILCE7M4' })
    expect(r).toMatchObject({
      status: 'copied',
      destPath: path.join(destDir, 'C0001-ILCE7M4_gol.MP4'),
    })
    expect(await sha256File(existing)).toBe(before)
    expect(await names(destDir)).toEqual(['C0001-ILCE7M4_gol.MP4', 'C0001_gol.MP4'])
  })

  it('keeps TOP after the tagged base', async () => {
    await write(path.join(destDir, 'C0001_TOP_gol.MP4'), 'older clip')
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'newer clip')
    const r = await copyVerified(src, destDir, 'C0001_TOP_gol.MP4', { cameraTag: 'ILCE7M4' })
    expect(r).toMatchObject({ destPath: path.join(destDir, 'C0001-ILCE7M4_TOP_gol.MP4') })
  })

  it('uses an explicit base for tagging when given', async () => {
    await write(path.join(destDir, 'A75_0449_gol.MP4'), 'older clip')
    const src = await write(path.join(srcDir, 'x.MP4'), 'newer clip')
    const r = await copyVerified(src, destDir, 'A75_0449_gol.MP4', {
      cameraTag: 'FX3',
      base: 'A75_0449',
    })
    expect(r).toMatchObject({ destPath: path.join(destDir, 'A75_0449-FX3_gol.MP4') })
  })

  it('adds (2), (3) without a tag and never touches existing files', async () => {
    const a = await write(path.join(destDir, 'C0001_gol.MP4'), 'one')
    const src2 = await write(path.join(srcDir, 'two.MP4'), 'two')
    const src3 = await write(path.join(srcDir, 'three.MP4'), 'three')
    const r2 = await copyVerified(src2, destDir, 'C0001_gol.MP4')
    const r3 = await copyVerified(src3, destDir, 'C0001_gol.MP4')
    expect(r2).toMatchObject({ destPath: path.join(destDir, 'C0001_gol (2).MP4') })
    expect(r3).toMatchObject({ destPath: path.join(destDir, 'C0001_gol (3).MP4') })
    expect(await fs.readFile(a, 'utf8')).toBe('one')
  })

  it('continues with (2) after the tagged name is also taken by different content', async () => {
    await write(path.join(destDir, 'C0001_gol.MP4'), 'one')
    await write(path.join(destDir, 'C0001-ILCE7M4_gol.MP4'), 'two')
    const src = await write(path.join(srcDir, 'three.MP4'), 'three')
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4', { cameraTag: 'ILCE7M4' })
    expect(r).toMatchObject({ destPath: path.join(destDir, 'C0001-ILCE7M4_gol (2).MP4') })
  })

  it('treats same-size different-content files as a conflict, not a duplicate', async () => {
    await write(path.join(destDir, 'C0001_gol.MP4'), 'aaaa')
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'bbbb')
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4')
    expect(r.status).toBe('copied')
    expect(await fs.readFile(path.join(destDir, 'C0001_gol.MP4'), 'utf8')).toBe('aaaa')
  })

  it('returns verify_failed and leaves the partial file when the re-read hash differs', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4', {
      hashFile: async () => 'f'.repeat(64),
    })
    expect(r).toEqual({
      status: 'verify_failed',
      tempPath: path.join(destDir, '.C0001_gol.MP4.partial'),
    })
    expect(await names(destDir)).toEqual(['.C0001_gol.MP4.partial'])
  })

  it('returns verify_failed when the temp file size differs', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const hashFile = vi.fn(async (p: string) => {
      // real hash of the source content, but the temp is then truncated -> size differs
      await fs.truncate(p, 3)
      return sha('footage')
    })
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4', { hashFile })
    expect(r.status).toBe('verify_failed')
    expect(await names(destDir)).toEqual(['.C0001_gol.MP4.partial'])
  })

  it('never reuses or modifies a stale partial file from an earlier run', async () => {
    const stale = await write(path.join(destDir, '.C0001_gol.MP4.partial'), 'half-written')
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4')
    expect(r.status).toBe('copied')
    expect(await fs.readFile(stale, 'utf8')).toBe('half-written')
    expect(await names(destDir)).toEqual(['.C0001_gol.MP4.partial', 'C0001_gol.MP4'])
  })

  it('removes its own temp when the result is a duplicate', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    await copyVerified(src, destDir, 'C0001_gol.MP4')
    await copyVerified(src, destDir, 'C0001_gol.MP4')
    expect(await names(destDir)).toEqual(['C0001_gol.MP4'])
  })

  it('awaits waitForSpace with the source size before writing', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'twelve bytes')
    const seen: Array<{ bytes: number; destEntries: string[] }> = []
    await copyVerified(src, destDir, 'C0001_gol.MP4', {
      waitForSpace: async (bytes) => {
        seen.push({ bytes, destEntries: await names(destDir) })
      },
    })
    expect(seen).toEqual([{ bytes: 12, destEntries: [] }])
  })

  it('does not write anything when waitForSpace rejects', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'x')
    await expect(
      copyVerified(src, destDir, 'C0001_gol.MP4', {
        waitForSpace: async () => {
          throw new Error('cancelled')
        },
      }),
    ).rejects.toThrow('cancelled')
    expect(await names(destDir)).toEqual([])
  })

  it('propagates source open errors with their original code', async () => {
    await expect(
      copyVerified(path.join(srcDir, 'missing.MP4'), destDir, 'C0001_gol.MP4'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await names(destDir)).toEqual([])
  })

  it.each(['EIO', 'ENXIO', 'ENOENT'])(
    'propagates a mid-read %s from the injected source stream and leaves no final file',
    async (code) => {
      const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
      let sent = false
      const openRead = (): NodeJS.ReadableStream =>
        new Readable({
          read() {
            if (!sent) {
              sent = true
              this.push(Buffer.from('foo'))
            } else {
              this.destroy(fsError(code))
            }
          },
        })
      await expect(
        copyVerified(src, destDir, 'C0001_gol.MP4', { openRead }),
      ).rejects.toMatchObject({ code })
      const left = await names(destDir)
      expect(left.filter((n) => !n.endsWith('.partial'))).toEqual([])
    },
  )

  it('treats a source stream that ends early without error as verify_failed', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4', {
      openRead: () => Readable.from([Buffer.from('foo')]),
    })
    expect(r.status).toBe('verify_failed')
    expect(await names(destDir)).toEqual(['.C0001_gol.MP4.partial'])
  })

  it('falls back to placeholder + rename when hard links are unsupported', async () => {
    const data = Buffer.from('footage on drive')
    const src = await write(path.join(srcDir, 'C0001.MP4'), data)
    for (const code of ['ENOTSUP', 'EPERM', 'EXDEV', 'ENOSYS']) {
      const dir = path.join(root, `drive-${code}`)
      await fs.mkdir(dir)
      const linkFn = vi.fn(async () => {
        throw fsError(code)
      })
      const r = await copyVerified(src, dir, 'C0001_gol.MP4', { linkFn })
      expect(r).toMatchObject({ status: 'copied', destPath: path.join(dir, 'C0001_gol.MP4') })
      expect(linkFn).toHaveBeenCalledTimes(1)
      expect((await fs.readFile(path.join(dir, 'C0001_gol.MP4'))).equals(data)).toBe(true)
      expect(await names(dir)).toEqual(['C0001_gol.MP4'])
    }
  })

  it('fallback path never overwrites an existing file and moves to the next name', async () => {
    const existing = await write(path.join(destDir, 'C0001_gol.MP4'), 'older clip')
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'newer clip')
    const linkFn = async (): Promise<void> => {
      throw fsError('ENOTSUP')
    }
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4', { linkFn })
    expect(r).toMatchObject({ status: 'copied', destPath: path.join(destDir, 'C0001_gol (2).MP4') })
    expect(await fs.readFile(existing, 'utf8')).toBe('older clip')
  })

  it('fallback path reports duplicate for identical existing content', async () => {
    await write(path.join(destDir, 'C0001_gol.MP4'), 'same')
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'same')
    const linkFn = async (): Promise<void> => {
      throw fsError('ENOTSUP')
    }
    const r = await copyVerified(src, destDir, 'C0001_gol.MP4', { linkFn })
    expect(r.status).toBe('duplicate')
    expect(await names(destDir)).toEqual(['C0001_gol.MP4'])
  })

  it('propagates unexpected link errors and keeps the verified temp', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const linkFn = async (): Promise<void> => {
      throw fsError('EIO')
    }
    await expect(copyVerified(src, destDir, 'C0001_gol.MP4', { linkFn })).rejects.toMatchObject({
      code: 'EIO',
    })
    expect(await names(destDir)).toEqual(['.C0001_gol.MP4.partial'])
  })

  it('rejects desired names that are not a plain file name', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'x')
    for (const bad of ['../evil.MP4', 'a/b.MP4', '', '.', '..']) {
      await expect(copyVerified(src, destDir, bad)).rejects.toThrow()
    }
    await expect(
      copyVerified(src, destDir, 'C0001_gol.MP4', { cameraTag: '../x' }),
    ).rejects.toThrow()
    expect(await names(destDir)).toEqual([])
    expect(await names(root)).toEqual(['card', 'drive'])
  })
})

describe('copyVerified fix round 1', () => {
  it('keeps the original source error when closing the temp handle also fails', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const realOpen = fsDefault.open.bind(fsDefault)
    vi.spyOn(fsDefault, 'open').mockImplementation((async (p: string, ...rest: unknown[]) => {
      const fh = await (realOpen as (...a: unknown[]) => Promise<fs.FileHandle>)(p, ...rest)
      if (p.endsWith('.partial')) {
        const realClose = fh.close.bind(fh)
        fh.close = async (): Promise<void> => {
          await realClose()
          throw fsError('EBADF')
        }
      }
      return fh
    }) as never)
    syncBuiltinESMExports()
    const openRead = (): NodeJS.ReadableStream =>
      new Readable({
        read() {
          this.destroy(fsError('EIO'))
        },
      })
    await expect(copyVerified(src, destDir, 'C0001_gol.MP4', { openRead })).rejects.toMatchObject({
      code: 'EIO',
    })
  })

  it('surfaces the close error when there was no other error', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const realOpen = fsDefault.open.bind(fsDefault)
    vi.spyOn(fsDefault, 'open').mockImplementation((async (p: string, ...rest: unknown[]) => {
      const fh = await (realOpen as (...a: unknown[]) => Promise<fs.FileHandle>)(p, ...rest)
      if (p.endsWith('.partial')) {
        const realClose = fh.close.bind(fh)
        fh.close = async (): Promise<void> => {
          await realClose()
          throw fsError('EIO')
        }
      }
      return fh
    }) as never)
    syncBuiltinESMExports()
    await expect(copyVerified(src, destDir, 'C0001_gol.MP4')).rejects.toMatchObject({ code: 'EIO' })
  })

  it('stops with an error (no further names tried) when the placeholder inode changes', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const realLstat = fsDefault.lstat.bind(fsDefault)
    vi.spyOn(fsDefault, 'lstat').mockImplementation((async (p: string, o?: object) => {
      const st = await realLstat(p, o as never)
      return p.endsWith('C0001_gol.MP4') ? Object.assign(st, { ino: Number(st.ino) + 1 }) : st
    }) as never)
    syncBuiltinESMExports()
    const linkFn = async (): Promise<void> => {
      throw fsError('ENOTSUP')
    }
    await expect(copyVerified(src, destDir, 'C0001_gol.MP4', { linkFn })).rejects.toThrow(
      /C0001_gol\.MP4 changed identity/,
    )
    // exactly one placeholder + the verified temp; no (2), (3) ... files
    expect(await names(destDir)).toEqual(['.C0001_gol.MP4.partial', 'C0001_gol.MP4'])
    expect(await fs.readFile(path.join(destDir, '.C0001_gol.MP4.partial'), 'utf8')).toBe('footage')
  })

  it('throws instead of looping forever when a write makes no progress', async () => {
    const src = await write(path.join(srcDir, 'C0001.MP4'), 'footage')
    const probe = await fs.open(src, 'r')
    const proto = Object.getPrototypeOf(probe) as { write: unknown }
    await probe.close()
    vi.spyOn(proto as { write: () => Promise<unknown> }, 'write').mockResolvedValue({
      bytesWritten: 0,
      buffer: Buffer.alloc(0),
    })
    await expect(copyVerified(src, destDir, 'C0001_gol.MP4')).rejects.toThrow(/no progress/)
  })
})

describe('makeSpaceWaiter', () => {
  const GB = 1024 ** 3

  it('resolves immediately when enough space is free', async () => {
    const onWaiting = vi.fn()
    const wait = makeSpaceWaiter('/x', { free: async () => 100 * GB, onWaiting, pollMs: 1 })
    await wait(10 * GB)
    expect(onWaiting).not.toHaveBeenCalled()
  })

  it('waits until the second poll and reports waiting once', async () => {
    const free = vi.fn<(d: string) => Promise<number>>()
    free.mockResolvedValueOnce(1 * GB).mockResolvedValue(100 * GB)
    const onWaiting = vi.fn()
    const wait = makeSpaceWaiter('/x', { free, onWaiting, pollMs: 5 })
    await wait(2 * GB)
    expect(free).toHaveBeenCalledTimes(2)
    expect(onWaiting).toHaveBeenCalledTimes(1)
    expect(onWaiting).toHaveBeenCalledWith(2 * GB + 5 * GB, 1 * GB)
  })

  it('reports waiting only once even if several polls fail', async () => {
    const free = vi.fn<(d: string) => Promise<number>>()
    free.mockResolvedValueOnce(1 * GB).mockResolvedValueOnce(2 * GB).mockResolvedValue(100 * GB)
    const onWaiting = vi.fn()
    const wait = makeSpaceWaiter('/x', { free, onWaiting, pollMs: 2 })
    await wait(1)
    expect(free).toHaveBeenCalledTimes(3)
    expect(onWaiting).toHaveBeenCalledTimes(1)
  })

  it('honours a custom reserve', async () => {
    const wait = makeSpaceWaiter('/x', { free: async () => 3 * GB, reserveBytes: 1 * GB, pollMs: 1 })
    await wait(1 * GB)
  })
})
