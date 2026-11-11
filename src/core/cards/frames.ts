import { ffmpegPath } from './bin'
import { runBinary } from './exec'

const W = 64
const H = 36
const CONCURRENCY = 3
const END_MARGIN_S = 0.05

function ffmpegArgs(rest: string[]): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', ...rest]
}

function sampleTimes(durationS: number, samples: number): number[] {
  const last = Math.max(0, durationS - END_MARGIN_S)
  return Array.from({ length: samples }, (_, i) => Math.min(last, (durationS * (i + 0.5)) / samples))
}

async function lumaAt(absPath: string, t: number): Promise<number | null> {
  const raw = await runBinary(
    ffmpegPath(),
    ffmpegArgs(['-ss', t.toFixed(3), '-i', absPath, '-frames:v', '1', '-an', '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']),
  )
  if (raw.length < W * H) return null
  let sum = 0
  for (let i = 0; i < W * H; i++) sum += raw[i] ?? 0
  return sum / (W * H * 255)
}

/** Mean luma (0..1) of `samples` 64x36 frames spread evenly over the clip. Samples without a frame are skipped. */
export async function frameLumas(absPath: string, durationS: number, samples = 6): Promise<number[]> {
  const times = sampleTimes(durationS, samples)
  const results: Array<number | null> = new Array<number | null>(times.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      const t = times[i]
      if (t === undefined) return
      results[i] = await lumaAt(absPath, t)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, times.length) }, worker))
  const values = results.filter((v): v is number => v !== null)
  if (values.length === 0) throw new Error(`No frames could be decoded from ${absPath}`)
  return values
}

const TILE_W = 512
const TILE_H = 288
const SHEET_POINTS = [0.15, 0.4, 0.65, 0.9]
// Lift flat (S-Log3 style) footage: contrast + saturation boost and a gentle S-curve.
const LIFT = 'eq=contrast=1.35:saturation=1.5,curves=all=0/0 0.25/0.2 0.75/0.8 1/1'

/** 1024x576 JPEG: 2x2 tiles of frames at 15/40/65/90 % of the clip, lifted for log footage. */
export async function contactSheet(absPath: string, durationS: number): Promise<Buffer> {
  const last = Math.max(0, durationS - END_MARGIN_S)
  const inputs = SHEET_POINTS.flatMap((p) => ['-ss', Math.min(last, durationS * p).toFixed(3), '-i', absPath])
  const tiles = SHEET_POINTS.map(
    (_, i) =>
      `[${i}:v]scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p,${LIFT}[t${i}]`,
  )
  const filter = `${tiles.join(';')};[t0][t1][t2][t3]xstack=inputs=4:layout=0_0|${TILE_W}_0|0_${TILE_H}|${TILE_W}_${TILE_H}[v]`
  const jpeg = await runBinary(
    ffmpegPath(),
    ffmpegArgs([...inputs, '-filter_complex', filter, '-map', '[v]', '-frames:v', '1', '-an', '-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1']),
  )
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error(`Contact sheet for ${absPath} is not a JPEG`)
  return jpeg
}
