import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../../src/core/pipeline'
import { newRun, type RunState } from '../../src/renderer/runState'
import { DEFAULT_TEMPLATES } from '../../src/core/templates'
import type { CardDetected, Settings } from '../../src/shared/ipc-types'
import { Done } from '../../src/renderer/screens/Done'
import { NewCard } from '../../src/renderer/screens/NewCard'
import { AI_UNAVAILABLE_MESSAGE, BACKUP_ONLY_HINT, NO_AI_DONE_MESSAGE } from '../../src/renderer/strings'

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
  it('shows orphan markers (a marker without a TOP clip before it)', () => {
    const html = renderDone(summary({ markers: 3, orphanMarkers: 2 }))
    expect(html).toMatch(/Osiřelé značky<\/span> \(bez TOP záběru, v CSV „bez TOP“\): 2/)
    expect(renderDone(summary({ markers: 1, orphanMarkers: 0 }))).not.toContain('Osiřelé')
  })

  it('says that the AI was unavailable and the rest was backed up unsorted', () => {
    expect(AI_UNAVAILABLE_MESSAGE).toBe('AI nedostupná — zbytek zálohován bez třídění.')
    expect(renderDone(summary({ ai: 'unavailable', unclassified: 2 }))).toContain(AI_UNAVAILABLE_MESSAGE)
    expect(renderDone(summary())).not.toContain('AI nedostupná')
  })
})

const card: CardDetected = {
  root: '/Volumes/CARD',
  volumeName: 'CARD',
  videos: 3,
  bytes: 1000,
  firstDate: '2026-10-01T10:00:00.000Z',
  lastDate: '2026-10-01T11:00:00.000Z',
}

const settings: Settings = {
  rootDir: '/Drive',
  model: 'claude-sonnet-5-5',
  templates: DEFAULT_TEMPLATES,
  lastTemplateId: DEFAULT_TEMPLATES[0]?.id ?? '',
  rosters: {},
  lumaThreshold: 0.2,
  czkPerUsd: 23,
}

function renderNewCard(hasKey: boolean): string {
  return renderToStaticMarkup(
    <NewCard
      card={card}
      preset={undefined}
      settings={settings}
      hasKey={hasKey}
      waiting={0}
      onStart={async () => null}
      onCancel={() => {}}
      onSettings={() => {}}
      onOpenSettings={() => {}}
    />,
  )
}

describe('NewCard', () => {
  it('offers "Zálohovat bez třídění" with a hint when there is no API key', () => {
    const html = renderNewCard(false)
    expect(html).toContain('Zálohovat bez třídění')
    expect(BACKUP_ONLY_HINT).toBe('Bez API klíče: vše se zálohuje do _nezařazeno, černé značky a TOP záběry se pořád poznají.')
    expect(html).toContain(BACKUP_ONLY_HINT)
    expect(html).toMatch(/<button type="button" class="primary big"[^>]*>Zálohovat bez třídění<\/button>/)
  })

  it('shows only the normal start with an API key', () => {
    const html = renderNewCard(true)
    expect(html).not.toContain('Zálohovat bez třídění')
    expect(html).toMatch(/<button type="submit" class="primary big">Start<\/button>/)
  })
})

describe('Done without AI', () => {
  it('says the backup ran without sorting instead of listing every clip as a failure', () => {
    const html = renderDone(summary({ ai: 'off', unclassified: 2, perFolder: { _nezařazeno: 2 } }))
    expect(html).toContain(NO_AI_DONE_MESSAGE)
    expect(html).not.toContain('nepodařilo roztřídit')
  })
})
