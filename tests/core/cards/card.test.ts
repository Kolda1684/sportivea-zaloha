import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { looksLikeCard, scanCard } from '../../../src/core/cards/card'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'card-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function touch(rel: string, content = 'x'): Promise<void> {
  const full = join(root, rel)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

describe('scanCard', () => {
  it('lists files recursively, classifies them and skips system entries', async () => {
    await touch('PRIVATE/M4ROOT/CLIP/C0001.MP4', 'abc')
    await touch('PRIVATE/M4ROOT/CLIP/C0001M01.XML')
    await touch('PRIVATE/M4ROOT/CLIP/._C0001.MP4')
    await touch('DCIM/100MSDCF/DSC00001.JPG')
    await touch('DCIM/100MSDCF/clip.mov')
    await touch('.Spotlight-V100/x')
    await touch('.fseventsd/y')
    await touch('.Trashes/501/z.MP4')
    await touch('.TemporaryItems/t.MP4')
    await touch('.DS_Store')
    await touch('DCIM/.DS_Store')

    const files = await scanCard(root)
    const byRel = Object.fromEntries(files.map((f) => [f.relPath, f]))

    expect(Object.keys(byRel).sort()).toEqual([
      'DCIM/100MSDCF/DSC00001.JPG',
      'DCIM/100MSDCF/clip.mov',
      'PRIVATE/M4ROOT/CLIP/C0001.MP4',
      'PRIVATE/M4ROOT/CLIP/C0001M01.XML',
    ])
    expect(byRel['PRIVATE/M4ROOT/CLIP/C0001.MP4']).toEqual({
      relPath: 'PRIVATE/M4ROOT/CLIP/C0001.MP4',
      absPath: join(root, 'PRIVATE/M4ROOT/CLIP/C0001.MP4'),
      size: 3,
      kind: 'video',
    })
    expect(byRel['DCIM/100MSDCF/clip.mov']?.kind).toBe('video')
    expect(byRel['PRIVATE/M4ROOT/CLIP/C0001M01.XML']?.kind).toBe('other')
    expect(byRel['DCIM/100MSDCF/DSC00001.JPG']?.kind).toBe('other')
  })

  it('recognizes all video extensions case-insensitively', async () => {
    for (const ext of ['mp4', 'MOV', 'Mxf', 'mts', 'M2TS', 'm4v', 'AVI']) {
      await touch(`v/clip.${ext}`)
    }
    const files = await scanCard(root)
    expect(files).toHaveLength(7)
    expect(files.every((f) => f.kind === 'video')).toBe(true)
  })

  it('treats Sony proxies (M4ROOT/SUB) and thumbnails (M4ROOT/THMBNL) as other files, case-insensitively', async () => {
    await touch('PRIVATE/M4ROOT/CLIP/C0001.MP4')
    await touch('PRIVATE/M4ROOT/SUB/C0001S03.MP4')
    await touch('PRIVATE/M4ROOT/THMBNL/C0001T01.JPG')
    await touch('X/m4root/sub/C0002S03.MP4') // own parents: the test volume may be case-insensitive
    await touch('Y/M4Root/Thmbnl/C0002T01.MOV')
    await touch('M4ROOT/SUB/deeper/C0003S03.MP4') // any depth below M4ROOT/SUB
    await touch('DCIM/SUB/clip.mp4') // SUB outside M4ROOT is a normal folder
    await touch('PRIVATE/M4ROOT/SUBCLIP/C0004.MP4') // only the exact segment counts

    const kinds = Object.fromEntries((await scanCard(root)).map((f) => [f.relPath, f.kind]))
    expect(kinds).toEqual({
      'DCIM/SUB/clip.mp4': 'video',
      'M4ROOT/SUB/deeper/C0003S03.MP4': 'other',
      'PRIVATE/M4ROOT/CLIP/C0001.MP4': 'video',
      'PRIVATE/M4ROOT/SUB/C0001S03.MP4': 'other',
      'PRIVATE/M4ROOT/SUBCLIP/C0004.MP4': 'video',
      'PRIVATE/M4ROOT/THMBNL/C0001T01.JPG': 'other',
      'X/m4root/sub/C0002S03.MP4': 'other',
      'Y/M4Root/Thmbnl/C0002T01.MOV': 'other',
    })
  })

  it('returns an empty list for an empty card', async () => {
    expect(await scanCard(root)).toEqual([])
  })

  it('does not modify the scanned tree', async () => {
    await touch('CLIP/C0001.MP4')
    await touch('._junk')
    const before = (await scanCard(root)).map((f) => f.relPath)
    await scanCard(root)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(root)).sort()).toEqual(['._junk', 'CLIP'])
    expect((await scanCard(root)).map((f) => f.relPath)).toEqual(before)
  })
})

describe('looksLikeCard', () => {
  it('is true for a Sony tree', async () => {
    await mkdir(join(root, 'PRIVATE/M4ROOT/CLIP'), { recursive: true })
    expect(await looksLikeCard(root)).toBe(true)
  })

  it.each(['DCIM', 'PRIVATE/AVCHD', 'CLIP', 'XDROOT'])('is true when %s exists', async (dir) => {
    await mkdir(join(root, dir), { recursive: true })
    expect(await looksLikeCard(root)).toBe(true)
  })

  it('is false for a plain folder', async () => {
    await mkdir(join(root, 'Documents'), { recursive: true })
    await touch('notes.txt')
    expect(await looksLikeCard(root)).toBe(false)
  })

  it('is false when the path does not exist', async () => {
    expect(await looksLikeCard(join(root, 'missing'))).toBe(false)
  })
})
