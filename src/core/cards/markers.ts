export type MarkerInput = {
  id: string
  durationS: number
  createdAt: Date | null
  cameraKey: string
  lumas: number[]
}

export type MarkerResult = {
  /** Black marker clips (hand over the lens): short and mostly dark. */
  markers: Set<string>
  /** The clip recorded right before a marker on the same camera. */
  top: Set<string>
  /** Markers for which no TOP clip could be assigned. */
  orphanMarkers: Set<string>
}

export type MarkerOptions = {
  maxDurationS?: number
  lumaThreshold?: number
  maxGapS?: number
}

function compareClips(a: MarkerInput, b: MarkerInput): number {
  // Undated clips go after dated ones; ties (and undated clips) by id.
  if (a.createdAt !== null && b.createdAt !== null) {
    const d = a.createdAt.getTime() - b.createdAt.getTime()
    if (d !== 0) return d
  } else if (a.createdAt !== null) {
    return -1
  } else if (b.createdAt !== null) {
    return 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function isMarker(clip: MarkerInput, maxDurationS: number, lumaThreshold: number): boolean {
  if (!(clip.durationS < maxDurationS) || clip.lumas.length === 0) return false
  const dark = clip.lumas.filter((l) => l < lumaThreshold).length
  return dark * 2 >= clip.lumas.length
}

/**
 * Black-marker rule: a clip shorter than `maxDurationS` with at least half of its luma samples below
 * `lumaThreshold`. The TOP clip is the one immediately before a marker on the same camera, if it is not
 * a marker itself and ended no more than `maxGapS` before the marker started.
 */
export function detectMarkers(clips: MarkerInput[], opts: MarkerOptions = {}): MarkerResult {
  const maxDurationS = opts.maxDurationS ?? 2.0
  const lumaThreshold = opts.lumaThreshold ?? 0.2
  const maxGapS = opts.maxGapS ?? 60

  const markers = new Set<string>()
  const top = new Set<string>()
  const orphanMarkers = new Set<string>()

  const byCamera = new Map<string, MarkerInput[]>()
  for (const clip of clips) {
    if (isMarker(clip, maxDurationS, lumaThreshold)) markers.add(clip.id)
    const list = byCamera.get(clip.cameraKey)
    if (list) list.push(clip)
    else byCamera.set(clip.cameraKey, [clip])
  }

  for (const list of byCamera.values()) {
    const sorted = [...list].sort(compareClips)
    sorted.forEach((clip, i) => {
      if (!markers.has(clip.id)) return
      const prev = i > 0 ? sorted[i - 1] : undefined
      if (prev === undefined || markers.has(prev.id) || prev.createdAt === null || clip.createdAt === null) {
        orphanMarkers.add(clip.id)
        return
      }
      const prevEndMs = prev.createdAt.getTime() + prev.durationS * 1000
      const gapS = (clip.createdAt.getTime() - prevEndMs) / 1000
      if (gapS <= maxGapS) top.add(prev.id)
      else orphanMarkers.add(clip.id)
    })
  }

  return { markers, top, orphanMarkers }
}
