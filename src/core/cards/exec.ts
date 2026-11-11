import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

const TIMEOUT_MS = 60_000
const STDERR_TAIL = 800

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcessByStdio<null, Readable, Readable>

export type RunBinaryOptions = {
  /** Kill the process (SIGKILL) after this long. Default 60 s. */
  timeoutMs?: number
  /** Injectable for tests. Default `child_process.spawn`. */
  spawnFn?: SpawnFn
}

/** A failure that says nothing about the input: the process could not start or hung (e.g. under heavy load). */
class TransientExecError extends Error {}

function runOnce(bin: string, args: string[], timeoutMs: number, spawnFn: SpawnFn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      reject(new TransientExecError(`${bin} could not start: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    const out: Buffer[] = []
    let err = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString('utf8')).slice(-STDERR_TAIL * 4)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(new TransientExecError(`${bin} could not start: ${e.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (timedOut) {
        reject(new TransientExecError(`${bin} timed out after ${timeoutMs} ms: ${err.slice(-STDERR_TAIL)}`))
      } else if (code !== 0) {
        reject(new Error(`${bin} exited with ${code ?? signal}: ${err.slice(-STDERR_TAIL)}`))
      } else {
        resolve(Buffer.concat(out))
      }
    })
  })
}

/**
 * Runs a binary with stdin ignored and a timeout (default 60 s); resolves with stdout bytes.
 * A timeout or a failure to start is retried exactly once (transient under load); a normal
 * non-zero exit is never retried.
 */
export async function runBinary(bin: string, args: string[], opts: RunBinaryOptions = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const spawnFn: SpawnFn = opts.spawnFn ?? spawn
  try {
    return await runOnce(bin, args, timeoutMs, spawnFn)
  } catch (e) {
    if (!(e instanceof TransientExecError)) throw e
    return runOnce(bin, args, timeoutMs, spawnFn)
  }
}
