import { execFileSync, spawnSync } from 'node:child_process'
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
})
