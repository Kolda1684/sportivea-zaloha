import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBinary, type SpawnFn } from '../../src/core/exec'

/** Wraps the real spawn, counts attempts and lets a test replace the command of chosen attempts. */
function countingSpawn(commandFor: (attempt: number, cmd: string) => string = (_a, cmd) => cmd): SpawnFn & { attempts: number } {
  const fn = ((cmd: string, args: string[], options: Parameters<SpawnFn>[2]) => {
    fn.attempts++
    return spawn(commandFor(fn.attempts, cmd), args, options)
  }) as SpawnFn & { attempts: number }
  fn.attempts = 0
  return fn
}

describe('runBinary', () => {
  it('resolves with stdout', async () => {
    const spawnFn = countingSpawn()
    const out = await runBinary('/bin/sh', ['-c', 'printf hello'], { spawnFn })
    expect(out.toString('utf8')).toBe('hello')
    expect(spawnFn.attempts).toBe(1)
  })

  it('never retries a normal non-zero exit', async () => {
    const spawnFn = countingSpawn()
    await expect(runBinary('/bin/sh', ['-c', 'echo nope >&2; exit 3'], { spawnFn })).rejects.toThrow(/exited with 3: nope/)
    expect(spawnFn.attempts).toBe(1)
  })

  it('retries exactly once after a timeout, then gives up', async () => {
    const spawnFn = countingSpawn()
    const started = Date.now()
    await expect(runBinary('/bin/sh', ['-c', 'exec sleep 5'], { timeoutMs: 100, spawnFn })).rejects.toThrow(/timed out after 100 ms/)
    expect(spawnFn.attempts).toBe(2)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('succeeds when the retry after a timeout works', async () => {
    // first attempt hangs, the second one answers at once
    const spawnFn = countingSpawn()
    const script = 'if [ -e "$0" ]; then printf ok; else : > "$0"; exec sleep 5; fi'
    const flag = join(tmpdir(), `trideni-exec-${process.pid}-${Date.now()}`)
    const out = await runBinary('/bin/sh', ['-c', script, flag], { timeoutMs: 300, spawnFn })
    expect(out.toString('utf8')).toBe('ok')
    expect(spawnFn.attempts).toBe(2)
    await rm(flag, { force: true })
  })

  it('retries exactly once when the binary could not be started', async () => {
    const spawnFn = countingSpawn((attempt, cmd) => (attempt === 1 ? '/nonexistent/trideni-binary' : cmd))
    const out = await runBinary('/bin/sh', ['-c', 'printf second'], { spawnFn })
    expect(out.toString('utf8')).toBe('second')
    expect(spawnFn.attempts).toBe(2)
  })

  it('reports a binary that cannot be started twice', async () => {
    const spawnFn = countingSpawn()
    await expect(runBinary('/nonexistent/trideni-binary', [], { spawnFn })).rejects.toThrow(/could not start/)
    expect(spawnFn.attempts).toBe(2)
  })
})
