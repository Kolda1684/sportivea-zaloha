import * as fs from 'node:fs/promises'

const DEFAULT_RESERVE_BYTES = 5 * 1024 ** 3
const DEFAULT_POLL_MS = 30_000

/** Bytes available to unprivileged writers on the volume holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await fs.statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/**
 * Returns a function that resolves once `dir`'s volume has `bytes` + reserve free.
 * While waiting it polls every `pollMs` and calls `onWaiting(needed, free)` once per call
 * (needed includes the reserve).
 */
export function makeSpaceWaiter(
  dir: string,
  opts: {
    reserveBytes?: number
    pollMs?: number
    free?: (d: string) => Promise<number>
    onWaiting?: (needed: number, free: number) => void
  } = {},
): (bytes: number) => Promise<void> {
  const reserve = opts.reserveBytes ?? DEFAULT_RESERVE_BYTES
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const free = opts.free ?? freeBytes
  return async (bytes: number): Promise<void> => {
    const needed = bytes + reserve
    let announced = false
    for (;;) {
      const available = await free(dir)
      if (available >= needed) return
      if (!announced) {
        announced = true
        opts.onWaiting?.(needed, available)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
    }
  }
}
