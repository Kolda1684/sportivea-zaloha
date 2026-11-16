import * as os from 'node:os'
import { describe, expect, it } from 'vitest'
import { freeBytes, importantUsageBytes } from '../../../src/core/cards/diskspace'

describe('freeBytes', () => {
  it('counts space macOS can purge for us (Drive cache, snapshots), not only empty blocks', async () => {
    // measured on Jan's Mac: statfs 16.5 GB, Finder / important usage 147.8 GB
    const free = await freeBytes('/Drive', { importantUsage: async () => 147.8e9, statfsFree: async () => 16.5e9 })
    expect(free).toBe(147.8e9)
  })

  it('falls back to empty blocks when macOS cannot be asked', async () => {
    const free = await freeBytes('/Drive', { importantUsage: async () => null, statfsFree: async () => 16.5e9 })
    expect(free).toBe(16.5e9)
  })

  it('never reports less than the empty blocks', async () => {
    const free = await freeBytes('/Drive', { importantUsage: async () => 1e9, statfsFree: async () => 16.5e9 })
    expect(free).toBe(16.5e9)
  })
})

describe.runIf(process.platform === 'darwin')('importantUsageBytes', () => {
  it('asks macOS for the space available for important use of a real folder', async () => {
    const bytes = await importantUsageBytes(os.tmpdir())
    expect(bytes).not.toBeNull()
    expect(bytes ?? 0).toBeGreaterThan(0)
  })

  it('returns null for a path that does not exist instead of throwing', async () => {
    expect(await importantUsageBytes('/nonexistent/sportivea-zaloha-test')).toBeNull()
  })
})
