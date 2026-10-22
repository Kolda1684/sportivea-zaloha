import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ffprobePath } from '../../src/core/bin'
import { contactSheet, frameLumas } from '../../src/core/frames'
import { probeClip } from '../../src/core/probe'
import { ensureFixtureClips, type FixtureClips } from '../fixtures/make-clips'

let clips: FixtureClips

beforeAll(async () => {
  clips = await ensureFixtureClips()
}, 120_000)

function ffprobeSize(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    )
  })
}

describe('probeClip', () => {
  it('reads duration, size and fps', async () => {
    const meta = await probeClip(clips.bright)
    expect(meta.durationS).toBeGreaterThan(4.9)
    expect(meta.durationS).toBeLessThan(5.1)
    expect(meta.width).toBe(1280)
    expect(meta.height).toBe(720)
    expect(meta.fps).toBeCloseTo(25, 1)
    expect(meta.createdAt).toBeNull()
    expect(meta.cameraModel).toBeNull()
  })

  it('finds a Sony modelName in the file tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'probe-'))
    try {
      const fake = join(dir, 'fake.bin')
      await writeFile(fake, Buffer.concat([Buffer.alloc(5_000_000, 1), Buffer.from('<Device manufacturer="Sony" modelName="ILCE-7M5" serialNo="1"/>')]))
      const { sniffCameraModel } = await import('../../src/core/probe')
      expect(await sniffCameraModel(fake)).toBe('ILCE-7M5')
      const none = join(dir, 'none.bin')
      await writeFile(none, Buffer.alloc(1000, 2))
      expect(await sniffCameraModel(none)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects for a missing file', async () => {
    await expect(probeClip('/nonexistent/x.mp4')).rejects.toThrow()
  })
})

describe('frameLumas', () => {
  it('is near zero for a black clip', async () => {
    const lumas = await frameLumas(clips.black, 0.6)
    expect(lumas.length).toBeGreaterThan(0)
    for (const l of lumas) expect(l).toBeLessThan(0.05)
  })

  it('is bright enough for a test pattern', async () => {
    const lumas = await frameLumas(clips.bright, 5)
    expect(lumas).toHaveLength(6)
    const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length
    expect(mean).toBeGreaterThan(0.3)
  })

  it('shows dark start and bright end for the half-dark clip', async () => {
    const lumas = await frameLumas(clips.halfDark, 1, 5)
    expect(lumas[0]).toBeLessThan(0.05)
    expect(lumas[lumas.length - 1]).toBeGreaterThan(0.2)
  })
})

describe('contactSheet', () => {
  it('returns a 1024x576 JPEG', async () => {
    const buf = await contactSheet(clips.bright, 5)
    expect(buf[0]).toBe(0xff)
    expect(buf[1]).toBe(0xd8)
    const dir = await mkdtemp(join(tmpdir(), 'sheet-'))
    try {
      const file = join(dir, 'sheet.jpg')
      await writeFile(file, buf)
      expect(await ffprobeSize(file)).toBe('1024,576')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
