import { describe, expect, it } from 'vitest'
import { checkTools } from '../../../src/main/cards/tools'

describe('checkTools', () => {
  it('is ok when ffprobe -version and ffmpeg -version both run', async () => {
    const calls: string[] = []
    const ok = await checkTools({
      ffprobe: () => '/x/ffprobe',
      ffmpeg: () => '/x/ffmpeg',
      run: async (bin, args) => {
        calls.push(`${bin} ${args.join(' ')}`)
        return Buffer.from('version')
      },
    })
    expect(ok).toBe(true)
    expect(calls).toEqual(['/x/ffprobe -version', '/x/ffmpeg -version'])
  })

  it('fails when a binary does not run, and logs why', async () => {
    const logs: string[] = []
    const ok = await checkTools({
      ffprobe: () => '/x/ffprobe',
      ffmpeg: () => '/x/ffmpeg',
      run: async (bin) => {
        if (bin.endsWith('ffmpeg')) throw new Error('could not start: ENOENT')
        return Buffer.from('')
      },
      log: (m) => logs.push(m),
    })
    expect(ok).toBe(false)
    expect(logs.join('\n')).toContain('ffmpeg')
    expect(logs.join('\n')).toContain('ENOENT')
  })

  it('fails when a binary cannot even be located (packaged app without ffprobe)', async () => {
    const ok = await checkTools({
      ffprobe: () => {
        throw new Error('ffprobe is missing from the app bundle')
      },
      ffmpeg: () => '/x/ffmpeg',
      run: async () => Buffer.from(''),
    })
    expect(ok).toBe(false)
  })

  it('runs the real bundled binaries in this checkout', async () => {
    expect(await checkTools()).toBe(true)
  })
})
