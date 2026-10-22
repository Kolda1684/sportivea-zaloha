import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegPath, ffprobePath, locateFfprobe } from '../../src/core/bin'

const probe = ffprobePath()
const libDir = join(dirname(probe), 'lib')
const isSystem = (ref: string): boolean => ref.startsWith('/usr/lib/') || ref.startsWith('/System/')

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

  // dev override / no bundle (e.g. not an arm64 Mac): nothing to check
  it.skipIf(!existsSync(libDir))('bundled ffprobe and its dylibs reference only system libraries or @loader_path', () => {
    const files = [probe, ...readdirSync(libDir).map((name) => join(libDir, name))]
    for (const file of files) {
      const refs = execFileSync('otool', ['-L', file], { encoding: 'utf8' })
        .split('\n')
        .slice(1) // the first line is the file itself
        .map((line) => /^\t(\S.*?) \(compatibility version/.exec(line)?.[1])
        .filter((ref): ref is string => ref !== undefined)
      expect(refs.length, file).toBeGreaterThan(0)
      for (const ref of refs) {
        if (isSystem(ref)) continue
        expect(ref, `${file} references ${ref}`).toMatch(/^@loader_path\//)
      }
    }
  })
})

describe('locateFfprobe', () => {
  it('uses resources/bin/ffprobe of the packaged app', () => {
    const resources = mkdtempSync(join(tmpdir(), 'trideni-resources-'))
    try {
      mkdirSync(join(resources, 'bin'))
      writeFileSync(join(resources, 'bin', 'ffprobe'), '')
      chmodSync(join(resources, 'bin', 'ffprobe'), 0o755)
      expect(locateFfprobe({ packaged: true, resourcesPath: resources })).toBe(join(resources, 'bin', 'ffprobe'))
    } finally {
      rmSync(resources, { recursive: true, force: true })
    }
  })

  it('fails clearly in a packaged app without the bundled ffprobe (no fallback to ffprobe-static)', () => {
    const resources = mkdtempSync(join(tmpdir(), 'trideni-resources-'))
    try {
      expect(() => locateFfprobe({ packaged: true, resourcesPath: resources })).toThrow(/ffprobe.*resources\/bin/)
      expect(() => locateFfprobe({ packaged: true, resourcesPath: undefined })).toThrow(/ffprobe/)
    } finally {
      rmSync(resources, { recursive: true, force: true })
    }
  })

  it('finds an ffprobe in development', () => {
    expect(locateFfprobe({ packaged: false, resourcesPath: undefined })).toMatch(/ffprobe$/)
  })
})
