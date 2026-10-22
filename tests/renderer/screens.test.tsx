import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../../src/core/pipeline'
import { newRun, type RunState } from '../../src/renderer/runState'
import { Done } from '../../src/renderer/screens/Done'
import { AI_UNAVAILABLE_MESSAGE } from '../../src/renderer/strings'

const summary = (patch: Partial<RunSummary> = {}): RunSummary => ({
  perFolder: { Zápas: 2 },
  top: 1,
  markers: 1,
  orphanMarkers: 0,
  unclassified: 0,
  lowConfidence: [],
  alreadyUploaded: 0,
  verifyFailed: [],
  others: 0,
  costUsd: 0,
  csvPath: '/Drive/Akce/_trideni_2026-10-22_10-00.csv',
  status: 'ok',
  ai: 'used',
  ...patch,
})

function run(): RunState {
  return { ...newRun({ cardRoot: '/Volumes/CARD', eventName: 'Akce', eventDir: '/Drive/Akce', templateName: 'Fotbal', startedAt: 1 }), phase: 'finished' }
}

function renderDone(s: RunSummary): string {
  return renderToStaticMarkup(<Done run={run()} summary={s} czkPerUsd={23} canRerun={false} onRerun={() => {}} onClose={() => {}} />)
}

describe('Done', () => {
  it('says that the AI was unavailable and the rest was backed up unsorted', () => {
    expect(AI_UNAVAILABLE_MESSAGE).toBe('AI nedostupná — zbytek zálohován bez třídění.')
    expect(renderDone(summary({ ai: 'unavailable', unclassified: 2 }))).toContain(AI_UNAVAILABLE_MESSAGE)
    expect(renderDone(summary())).not.toContain('AI nedostupná')
  })
})
