import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../../src/core/pipeline'
import type { ClassifyResult } from '../../src/core/classifier'
import type { RunUiEvent } from '../../src/shared/ipc-types'
import { countClassifyFailures, newRun, progressOf, reduceRun, type RunState } from '../../src/renderer/runState'

const EVENT_DIR = '/Drive/Akce/2026-10-20 Istanbul'

function start(): RunState {
  return newRun({ cardRoot: '/Volumes/CARD', eventName: '2026-10-20 Istanbul', eventDir: EVENT_DIR, templateName: 'Fotbal', startedAt: 1 })
}

function apply(state: RunState, ...events: RunUiEvent[]): RunState {
  return events.reduce(reduceRun, state)
}

const ok = (category: string, description = 'gol', confidence: ClassifyResult['confidence'] = 'high'): ClassifyResult => ({
  category,
  description,
  confidence,
  ok: true,
})

const summary = (patch: Partial<RunSummary> = {}): RunSummary => ({
  perFolder: {},
  top: 0,
  markers: 0,
  orphanMarkers: 0,
  unclassified: 0,
  lowConfidence: [],
  alreadyUploaded: 0,
  verifyFailed: [],
  others: 0,
  costUsd: 0,
  csvPath: '',
  status: 'ok',
  ...patch,
})

describe('reduceRun lifecycle', () => {
  it('starts as "starting" and follows queued / started / done', () => {
    let s = start()
    expect(s.phase).toBe('starting')
    s = apply(s, { type: 'queued', position: 1 })
    expect(s.phase).toBe('queued')
    expect(s.queuePosition).toBe(1)
    s = apply(s, { type: 'started' })
    expect(s.phase).toBe('running')
    s = apply(s, { type: 'done', summary: summary() })
    expect(s.phase).toBe('finished')
    expect(s.summary?.status).toBe('ok')
  })

  it('records a failure message', () => {
    const s = apply(start(), { type: 'failed', message: 'Disk je plný' })
    expect(s.phase).toBe('failed')
    expect(s.failure).toBe('Disk je plný')
  })

  it('remembers that the card was removed', () => {
    const s = apply(start(), { type: 'started' }, { type: 'card_removed' })
    expect(s.cardRemoved).toBe(true)
  })
})

describe('progress counting', () => {
  it('counts classified events (markers included) for sorting and copied events for uploading', () => {
    let s = apply(
      start(),
      { type: 'started' },
      { type: 'scanned', videos: 3, others: 1, bytes: 100 },
      { type: 'classified', relPath: 'DAY 1/Trénink/A75_0414.MP4', result: ok('_nezařazeno', ''), top: false, marker: true },
    )
    expect(progressOf(s)).toEqual({ sortedDone: 1, sortedTotal: 4, copyDone: 0, copyTotal: 3 })

    s = apply(
      s,
      { type: 'classified', relPath: 'DAY 1/Trénink/A75_0413.MP4', result: ok('Trénink'), top: true, marker: false },
      { type: 'classified', relPath: 'DAY 2/FX3-A_9301.MP4', result: ok('Zápas'), top: false, marker: false },
    )
    expect(progressOf(s).sortedDone).toBe(3)

    s = apply(s, {
      type: 'copied',
      relPath: 'DAY 1/Trénink/A75_0413.MP4',
      outcome: { status: 'copied', destPath: `${EVENT_DIR}/Trénink/A75_0413_TOP_gol.MP4`, bytes: 10, sha256: 'x' },
    })
    expect(progressOf(s)).toEqual({ sortedDone: 3, sortedTotal: 4, copyDone: 1, copyTotal: 3 })
  })

  it('counts a copy of a never-classified path (journal skip, non-video file) as sorted', () => {
    let s = apply(start(), { type: 'scanned', videos: 1, others: 1, bytes: 1 })
    s = apply(
      s,
      { type: 'copied', relPath: 'A.MP4', outcome: { status: 'duplicate', destPath: `${EVENT_DIR}/Zápas/A_gol.MP4`, sha256: 'x' } },
      { type: 'copied', relPath: 'notes.txt', outcome: { status: 'copied', destPath: `${EVENT_DIR}/_ostatni/notes.txt`, bytes: 1, sha256: 'y' } },
    )
    expect(progressOf(s)).toEqual({ sortedDone: 2, sortedTotal: 2, copyDone: 2, copyTotal: 2 })
  })

  it('does not count a clip twice when it is classified and then copied', () => {
    let s = apply(start(), { type: 'scanned', videos: 1, others: 0, bytes: 1 })
    s = apply(
      s,
      { type: 'classified', relPath: 'A.MP4', result: ok('Zápas'), top: false, marker: false },
      { type: 'copied', relPath: 'A.MP4', outcome: { status: 'copied', destPath: `${EVENT_DIR}/Zápas/A_gol.MP4`, bytes: 1, sha256: 'x' } },
    )
    expect(progressOf(s)).toEqual({ sortedDone: 1, sortedTotal: 1, copyDone: 1, copyTotal: 1 })
    expect(s.items).toHaveLength(1)
  })

  it('falls back to the number of seen items before the scan result arrives', () => {
    const s = apply(start(), { type: 'classified', relPath: 'A.MP4', result: ok('Zápas'), top: false, marker: false })
    expect(progressOf(s).sortedTotal).toBe(1)
  })
})

describe('items', () => {
  it('shows the destination name and folder of a copied clip', () => {
    const s = apply(
      start(),
      { type: 'classified', relPath: 'DAY 1/Trénink/A75_0413.MP4', result: ok('Trénink', 'kacor-gol', 'low'), top: true, marker: false },
      {
        type: 'copied',
        relPath: 'DAY 1/Trénink/A75_0413.MP4',
        outcome: { status: 'copied', destPath: `${EVENT_DIR}/Trénink/A75_0413_TOP_kacor-gol.MP4`, bytes: 10, sha256: 'x' },
      },
    )
    expect(s.items[0]).toMatchObject({
      relPath: 'DAY 1/Trénink/A75_0413.MP4',
      state: 'copied',
      top: true,
      lowConfidence: true,
      destName: 'A75_0413_TOP_kacor-gol.MP4',
      destFolder: 'Trénink',
    })
  })

  it('keeps nested destination folders relative to the event folder', () => {
    const s = apply(start(), {
      type: 'copied',
      relPath: 'PRIVATE/a.xml',
      outcome: { status: 'copied', destPath: `${EVENT_DIR}/_ostatni/PRIVATE/a.xml`, bytes: 1, sha256: 'x' },
    })
    expect(s.items[0]?.destFolder).toBe('_ostatni/PRIVATE')
  })

  it('marks a duplicate and a failed verification', () => {
    const s = apply(
      start(),
      { type: 'copied', relPath: 'A.MP4', outcome: { status: 'duplicate', destPath: `${EVENT_DIR}/Zápas/A.MP4`, sha256: 'x' } },
      { type: 'copied', relPath: 'B.MP4', outcome: { status: 'verify_failed', tempPath: `${EVENT_DIR}/Zápas/.tmp-B` } },
    )
    expect(s.items.map((i) => i.state)).toEqual(['duplicate', 'verify_failed'])
    expect(s.items[1]?.destName).toBeNull()
  })

  it('records a failed classification', () => {
    const failed: ClassifyResult = { category: '_nezařazeno', description: '', confidence: 'low', ok: false, error: 'bad key' }
    const s = apply(start(), { type: 'classified', relPath: 'A.MP4', result: failed, top: false, marker: false })
    expect(s.items[0]).toMatchObject({ classifyOk: false, lowConfidence: false })
  })

  it('flags marker clips', () => {
    const s = apply(start(), { type: 'classified', relPath: 'M.MP4', result: ok('_nezařazeno', ''), top: false, marker: true })
    expect(s.items[0]?.marker).toBe(true)
  })
})

describe('waiting for disk space', () => {
  it('shows the note until the next copy finishes', () => {
    let s = apply(start(), { type: 'waiting_space', needed: 10, free: 1 })
    expect(s.waitingSpace).toBe(true)
    s = apply(s, { type: 'copied', relPath: 'A.MP4', outcome: { status: 'copied', destPath: `${EVENT_DIR}/Zápas/A.MP4`, bytes: 1, sha256: 'x' } })
    expect(s.waitingSpace).toBe(false)
  })

  it('is cleared when the run ends', () => {
    const s = apply(start(), { type: 'waiting_space', needed: 10, free: 1 }, { type: 'done', summary: summary({ status: 'aborted' }) })
    expect(s.waitingSpace).toBe(false)
  })
})

describe('countClassifyFailures', () => {
  it('counts failed classifications but not markers or successes', () => {
    const failed: ClassifyResult = { category: '_nezařazeno', description: '', confidence: 'low', ok: false, error: 'x' }
    const s = apply(
      start(),
      { type: 'classified', relPath: 'A.MP4', result: failed, top: false, marker: false },
      { type: 'classified', relPath: 'B.MP4', result: failed, top: true, marker: false },
      { type: 'classified', relPath: 'C.MP4', result: ok('Zápas'), top: false, marker: false },
      { type: 'classified', relPath: 'M.MP4', result: ok('_nezařazeno', ''), top: false, marker: true },
    )
    expect(countClassifyFailures(s)).toBe(2)
  })
})
