import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ffmpegPath } from '../../src/core/bin'

export type FixtureClips = { black: string; bright: string; halfDark: string }

const cacheDir = join(dirname(fileURLToPath(import.meta.url)), '.cache')

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 60_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`fixture ffmpeg failed: ${stderr.slice(-500)}`))
      else resolve()
    })
  })
}

const encode = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25', '-an']

async function make(name: string, args: string[]): Promise<string> {
  const out = join(cacheDir, name)
  if (existsSync(out)) return out
  const tmp = join(cacheDir, `tmp-${process.pid}-${name}`)
  await run([...args, ...encode, '-f', 'mp4', tmp])
  await rename(tmp, out)
  return out
}

/** Generates (once, cached) 1280x720 test clips: black 0.6 s, testsrc2 5 s, 0.6 s black then testsrc2 (1 s). */
export async function ensureFixtureClips(): Promise<FixtureClips> {
  await mkdir(cacheDir, { recursive: true })
  const [black, bright, halfDark] = await Promise.all([
    make('black_0_6s.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=25:d=0.6']),
    make('bright_5s.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=5']),
    make('half_dark_1s.mp4', [
      '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=25:d=0.6',
      '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=0.4',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    ]),
  ])
  return { black, bright, halfDark }
}
