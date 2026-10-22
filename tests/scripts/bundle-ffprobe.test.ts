import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(__dirname, '..', '..', 'scripts', 'bundle-ffprobe.mjs')
// x86_64 binary shipped by ffprobe-static in its darwin/arm64 folder
const notArm64 = join(__dirname, '..', '..', 'node_modules', 'ffprobe-static', 'bin', 'darwin', 'arm64', 'ffprobe')

/** Every case below stops at the source checks, before resources/bin is touched. */
function bundle(source: string, ...args: string[]): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TRIDENI_FFPROBE_SOURCE: source },
  })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

describe('bundle-ffprobe.mjs', () => {
  it('only warns about a missing source by default (postinstall must not fail)', () => {
    const r = bundle('/nonexistent/ffprobe')
    expect(r.status).toBe(0)
    expect(r.output).toContain('not found')
  })

  it('fails on a missing source with --require (npm run app)', () => {
    const r = bundle('/nonexistent/ffprobe', '--require')
    expect(r.status).toBe(1)
    expect(r.output).toContain('not found')
    expect(r.output).toContain('cannot be packaged')
  })

  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64' || !existsSync(notArm64))('fails on a non-arm64 source with --require, warns without', () => {
    expect(bundle(notArm64).status).toBe(0)
    const r = bundle(notArm64, '--require')
    expect(r.status).toBe(1)
    expect(r.output).toContain('not arm64')
  })
})
