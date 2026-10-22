import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegPath, ffprobePath } from '../../src/core/bin'

describe('bundled binaries', () => {
  it('bundled ffmpeg and ffprobe run', () => {
    for (const bin of [ffmpegPath(), ffprobePath()]) {
      const result = spawnSync(bin, ['-version'], { encoding: 'utf8' })
      expect(result.status, `${bin} exit code`).toBe(0)
      expect(result.stdout).toMatch(/ffmpeg version|ffprobe version/)
    }
  })

  it('bundled ffmpeg and ffprobe are arm64', () => {
    for (const bin of [ffmpegPath(), ffprobePath()]) {
      const description = execFileSync('file', ['-b', bin], { encoding: 'utf8' })
      expect(description, bin).toContain('arm64')
      expect(description, bin).not.toContain('x86_64')
    }
  })

  it('bundled ffprobe and its dylibs do not reference Homebrew', () => {
    const probe = ffprobePath()
    const libDir = join(dirname(probe), 'lib')
    if (!existsSync(libDir)) return // dev override / no bundle: nothing to check
    const files = [probe, ...readdirSync(libDir).map((name) => join(libDir, name))]
    for (const file of files) {
      const refs = execFileSync('otool', ['-L', file], { encoding: 'utf8' })
      expect(refs, file).not.toContain('/opt/homebrew')
    }
  })
})
