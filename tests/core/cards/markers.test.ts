import { describe, expect, it } from 'vitest'
import { detectMarkers, type MarkerInput } from '../../../src/core/cards/markers'

const T0 = Date.parse('2026-10-01T10:00:00Z')

function clip(id: string, offsetS: number, durationS: number, lumas: number[], cameraKey = 'A'): MarkerInput {
  return { id, durationS, createdAt: new Date(T0 + offsetS * 1000), cameraKey, lumas }
}

const BRIGHT = [0.4, 0.4, 0.4, 0.4, 0.4, 0.4]

describe('detectMarkers', () => {
  it('detects a short mostly-dark clip as marker and the previous clip as TOP', () => {
    const r = detectMarkers([
      clip('top', 0, 15, BRIGHT),
      clip('mark', 17, 0.5, [0.02, 0.03, 0.4, 0.02, 0.02, 0.5]),
    ])
    expect([...r.markers]).toEqual(['mark'])
    expect([...r.top]).toEqual(['top'])
    expect(r.orphanMarkers.size).toBe(0)
  })

  it('does not treat a 1.4 s bright clip as marker', () => {
    const r = detectMarkers([clip('a', 0, 15, BRIGHT), clip('b', 16, 1.4, [0.6, 0.6, 0.6, 0.6, 0.6, 0.6])])
    expect(r.markers.size).toBe(0)
    expect(r.top.size).toBe(0)
  })

  it('does not treat a long dark clip as marker', () => {
    const r = detectMarkers([clip('a', 0, 15, BRIGHT), clip('b', 16, 5, [0.01, 0.01, 0.01])])
    expect(r.markers.size).toBe(0)
  })

  it('requires at least half of the samples below the threshold', () => {
    const half = detectMarkers([clip('a', 0, 5, BRIGHT), clip('b', 6, 1, [0.1, 0.1, 0.1, 0.4, 0.4, 0.4])])
    expect(half.markers.has('b')).toBe(true)
    const fewer = detectMarkers([clip('a', 0, 5, BRIGHT), clip('b', 6, 1, [0.1, 0.1, 0.4, 0.4, 0.4, 0.4])])
    expect(fewer.markers.has('b')).toBe(false)
  })

  it('never treats a clip with no lumas as marker', () => {
    expect(detectMarkers([clip('b', 0, 0.5, [])]).markers.size).toBe(0)
  })

  it('orphans a marker whose previous clip ended more than 60 s earlier', () => {
    // top ends at 10 s, marker starts at 100 s -> gap 90 s
    const r = detectMarkers([clip('top', 0, 10, BRIGHT), clip('mark', 100, 0.5, [0.02, 0.02, 0.02])])
    expect([...r.markers]).toEqual(['mark'])
    expect(r.top.size).toBe(0)
    expect([...r.orphanMarkers]).toEqual(['mark'])
  })

  it('accepts a gap of exactly maxGapS and honours custom options', () => {
    const edge = detectMarkers([clip('top', 0, 10, BRIGHT), clip('mark', 70, 0.5, [0.02, 0.02, 0.02])])
    expect([...edge.top]).toEqual(['top'])
    const strict = detectMarkers([clip('top', 0, 10, BRIGHT), clip('mark', 70, 0.5, [0.02, 0.02, 0.02])], { maxGapS: 30 })
    expect(strict.orphanMarkers.has('mark')).toBe(true)
  })

  it('orphans the second of two consecutive markers', () => {
    const dark = [0.02, 0.02, 0.02]
    const r = detectMarkers([clip('top', 0, 10, BRIGHT), clip('m1', 11, 0.5, dark), clip('m2', 13, 0.5, dark)])
    expect([...r.markers].sort()).toEqual(['m1', 'm2'])
    expect([...r.top]).toEqual(['top'])
    expect([...r.orphanMarkers]).toEqual(['m2'])
  })

  it('does not cross cameras', () => {
    const r = detectMarkers([
      clip('topA', 0, 10, BRIGHT, 'A'),
      clip('markB', 11, 0.5, [0.02, 0.02, 0.02], 'B'),
    ])
    expect(r.top.size).toBe(0)
    expect([...r.orphanMarkers]).toEqual(['markB'])
  })

  it('picks the previous clip within the same camera even if another camera is interleaved', () => {
    const r = detectMarkers([
      clip('topA', 0, 10, BRIGHT, 'A'),
      clip('otherB', 11, 5, BRIGHT, 'B'),
      clip('markA', 12, 0.5, [0.02, 0.02, 0.02], 'A'),
    ])
    expect([...r.top]).toEqual(['topA'])
  })

  it('sorts by createdAt then id regardless of input order', () => {
    const r = detectMarkers([
      clip('mark', 12, 0.5, [0.02, 0.02, 0.02]),
      clip('top', 0, 10, BRIGHT),
    ])
    expect([...r.top]).toEqual(['top'])
  })

  it('breaks createdAt ties by id', () => {
    const r = detectMarkers([
      clip('b-mark', 5, 0.5, [0.02, 0.02, 0.02]),
      clip('a-top', 5, 0.5, BRIGHT),
    ])
    expect([...r.markers]).toEqual(['b-mark'])
    expect([...r.top]).toEqual(['a-top'])
  })

  it('sorts clips without createdAt after dated ones by id; they can be markers but never get TOP across a null time', () => {
    const nullClip = (id: string, durationS: number, lumas: number[]): MarkerInput => ({ id, durationS, createdAt: null, cameraKey: 'A', lumas })
    const r = detectMarkers([
      nullClip('n2', 0.5, [0.02, 0.02, 0.02]),
      nullClip('n1', 10, BRIGHT),
      clip('dated', 0, 10, BRIGHT),
    ])
    expect([...r.markers]).toEqual(['n2'])
    expect(r.top.size).toBe(0)
    expect([...r.orphanMarkers]).toEqual(['n2'])
  })

  it('does not give TOP to a dated clip before a null-time marker', () => {
    const r = detectMarkers([
      clip('dated', 0, 10, BRIGHT),
      { id: 'n', durationS: 0.5, createdAt: null, cameraKey: 'A', lumas: [0.02, 0.02] },
    ])
    expect(r.top.size).toBe(0)
    expect(r.orphanMarkers.has('n')).toBe(true)
  })

  it('does not give TOP to a null-time clip before a dated marker', () => {
    // null-time clips sort last, so this marker is first in order and has no predecessor
    const r = detectMarkers([
      { id: 'n', durationS: 10, createdAt: null, cameraKey: 'A', lumas: BRIGHT },
      clip('mark', 0, 0.5, [0.02, 0.02]),
    ])
    expect(r.top.size).toBe(0)
    expect(r.orphanMarkers.has('mark')).toBe(true)
  })

  it('orphans a marker that is the first clip of its camera', () => {
    const r = detectMarkers([clip('mark', 0, 0.5, [0.02, 0.02])])
    expect([...r.orphanMarkers]).toEqual(['mark'])
  })
})
