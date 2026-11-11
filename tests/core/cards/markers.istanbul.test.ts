import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanCard } from '../../../src/core/cards/card'
import { frameLumas } from '../../../src/core/cards/frames'
import { detectMarkers, type MarkerInput } from '../../../src/core/cards/markers'
import { probeClip } from '../../../src/core/cards/probe'

const ROOT = process.env['TRIDENI_ISTANBUL_DIR'] ?? '/Volumes/Untitled/PRIVATE/M4ROOT/CLIP'
const CSV = '/Users/kolda/Desktop/Istanbul/_trideni_mapovani.csv'
const CONCURRENCY = 4

const nfc = (s: string): string => s.normalize('NFC')

type Truth = { markers: Set<string>; top: Set<string> }

async function loadTruth(): Promise<Truth> {
  const text = (await readFile(CSV, 'utf8')).replace(/^\uFEFF/, '')
  const [header, ...rows] = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  expect(header).toBe('puvodni_nazev;novy_nazev;slozka;poznamka')
  const markers = new Set<string>()
  const top = new Set<string>()
  for (const row of rows) {
    const [orig, novy, slozka] = row.split(';')
    if (orig === undefined || novy === undefined) continue
    if (slozka === '(kořen)') markers.add(nfc(orig))
    if (novy.includes('_TOP_')) top.add(nfc(orig))
  }
  return { markers, top }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      const item = items[i]
      if (item === undefined) return
      out[i] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

describe.skipIf(process.env['TRIDENI_INTEGRATION'] !== '1' || !existsSync(ROOT) || !existsSync(CSV))('markers on the Istanbul card', () => {
  it(
    'finds exactly the CSV markers and TOP clips',
    { timeout: 900_000 },
    async () => {
      const truth = await loadTruth()
      expect(truth.markers.size).toBe(14)
      expect(truth.top.size).toBe(14)

      const files = (await scanCard(ROOT)).filter((f) => f.kind === 'video')
      const inputs = await mapLimited(files, CONCURRENCY, async (f): Promise<MarkerInput> => {
        const meta = await probeClip(f.absPath)
        const lumas = await frameLumas(f.absPath, meta.durationS)
        return { id: nfc(basename(f.absPath)), durationS: meta.durationS, createdAt: meta.createdAt, cameraKey: meta.cameraModel ?? 'unknown', lumas }
      })

      const result = detectMarkers(inputs)
      const diff = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x)).sort()
      const report = {
        markersExtra: diff(result.markers, truth.markers),
        markersMissing: diff(truth.markers, result.markers),
        topExtra: diff(result.top, truth.top),
        topMissing: diff(truth.top, result.top),
        orphans: [...result.orphanMarkers].sort(),
      }
      console.log(`markers ${result.markers.size}/14, top ${result.top.size}/14`, JSON.stringify(report))

      expect(report.markersExtra).toEqual([])
      expect(report.markersMissing).toEqual([])
      expect(report.topExtra).toEqual([])
      expect(report.topMissing).toEqual([])
      expect(report.orphans).toEqual([])
    },
  )
})
