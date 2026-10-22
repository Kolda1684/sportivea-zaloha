import { spawn } from 'node:child_process'

const TIMEOUT_MS = 60_000
const STDERR_TAIL = 800

/** Runs a binary with stdin ignored and a 60 s timeout; resolves with stdout bytes. */
export function runBinary(bin: string, args: string[], timeoutMs: number = TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    let timedOut = false
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
      reject(new Error(`${bin} could not start: ${e.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${bin} timed out after ${timeoutMs} ms: ${err.slice(-STDERR_TAIL)}`))
      } else if (code !== 0) {
        reject(new Error(`${bin} exited with ${code ?? signal}: ${err.slice(-STDERR_TAIL)}`))
      } else {
        resolve(Buffer.concat(out))
      }
    })
  })
}
