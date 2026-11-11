import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../../../src/core/cards/pipeline'
import { newRun, type RunState } from '../../../src/renderer/cards/runState'
import { DEFAULT_TEMPLATES } from '../../../src/core/cards/templates'
import type { CardDetected, Settings } from '../../../src/shared/cards-ipc'
import { Done } from '../../../src/renderer/cards/screens/Done'
import { NewCard } from '../../../src/renderer/cards/screens/NewCard'
import { AI_UNAVAILABLE_MESSAGE, BACKUP_ONLY_HINT, NO_AI_DONE_MESSAGE, TOOLS_MISSING_MESSAGE } from '../../../src/renderer/cards/strings'

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

function renderNewCard(hasKey: boolean, toolsOk = true, rootDir: string | null = settings.rootDir): string {
  return renderToStaticMarkup(
    <NewCard
      card={card}
      preset={undefined}
      settings={{ ...settings, rootDir }}
      hasKey={hasKey}
      toolsOk={toolsOk}
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

  it('refuses to start when ffprobe/ffmpeg are missing', () => {
    expect(TOOLS_MISSING_MESSAGE).toBe('Chybí nástroj ffprobe/ffmpeg — aplikace je poškozená, kontaktuj Jana.')
    const withKey = renderNewCard(true, false)
    expect(withKey).toContain(TOOLS_MISSING_MESSAGE)
    expect(withKey).toMatch(/<button type="submit" class="primary big" disabled="">Start<\/button>/)
    expect(renderNewCard(false, false)).toMatch(/<button type="button" class="primary big" disabled="">Zálohovat bez třídění<\/button>/)
    expect(renderNewCard(true, true)).not.toContain(TOOLS_MISSING_MESSAGE)
  })

  it('shows the destination folder on the card screen with a button to change it', () => {
    const html = renderNewCard(true, true, '/Users/kolda/Library/CloudStorage/GoogleDrive-jan.kolar@sportivea.cz/Můj disk/Akce')
    expect(html).toContain('Kam nahrát')
    expect(html).toContain('Google Disk › Můj disk › Akce')
    expect(html).toContain('Změnit složku')
  })

  it('asks for the destination folder on the card screen when none is chosen yet', () => {
    const html = renderNewCard(true, true, null)
    expect(html).toContain('Kam nahrát')
    expect(html).toContain('Vybrat složku')
    expect(html).not.toContain('Otevřít nastavení')
    expect(html).toMatch(/<button type="submit" class="primary big" disabled="">Start<\/button>/)
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
