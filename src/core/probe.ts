import { open } from 'node:fs/promises'
import { ffprobePath } from './bin'
import { runBinary } from './exec'

export type ClipMeta = {
  durationS: number
  width: number
  height: number
  fps: number
  createdAt: Date | null
  cameraModel: string | null
}

type ProbeJson = {
  streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }>
  format?: { duration?: string; tags?: Record<string, string> }
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0
  const [n, d] = rate.split('/')
  const num = Number(n)
  const den = d === undefined ? 1 : Number(d)
  return den > 0 && Number.isFinite(num) ? num / den : 0
}

const SNIFF_BYTES = 4 * 1024 * 1024
const MODEL_RE = /modelName="([^"]{1,64})"/

/** Looks for Sony's embedded XML (`modelName="…"`) in the first and last 4 MB of the file (read-only). */
export async function sniffCameraModel(absPath: string): Promise<string | null> {
  const handle = await open(absPath, 'r')
  try {
    const { size } = await handle.stat()
    const len = Math.min(SNIFF_BYTES, size)
    const offsets = size > len ? [size - len, 0] : [0]
    for (const position of offsets) {
      const buf = Buffer.alloc(len)
      const { bytesRead } = await handle.read(buf, 0, len, position)
      const match = MODEL_RE.exec(buf.toString('latin1', 0, bytesRead))
      if (match?.[1]) return match[1]
    }
    return null
  } finally {
    await handle.close()
  }
}

export async function probeClip(absPath: string): Promise<ClipMeta> {
  const raw = await runBinary(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath])
  const json = JSON.parse(raw.toString('utf8')) as ProbeJson
  const video = json.streams?.find((s) => s.codec_type === 'video')
  if (!video?.width || !video.height) throw new Error(`No video stream in ${absPath}`)
  const durationS = Number(json.format?.duration ?? video.duration)
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error(`Unknown duration of ${absPath}`)
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate)
  const created = json.format?.tags?.['creation_time']
  const createdDate = created ? new Date(created) : null
  const createdAt = createdDate && !Number.isNaN(createdDate.getTime()) ? createdDate : null
  return {
    durationS,
    width: video.width,
    height: video.height,
    fps,
    createdAt,
    cameraModel: await sniffCameraModel(absPath),
  }
}
