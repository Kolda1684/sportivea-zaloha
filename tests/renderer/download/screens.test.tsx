import { isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EntryOutcome, PlanSummary, PreflightInfo, RunDone, RunStatus } from '../../../src/shared/download-ipc'
import { Choose, type ChooseProps } from '../../../src/renderer/download/screens/Choose'
import { Done, type DoneProps } from '../../../src/renderer/download/screens/Done'
import {
  Progress,
  STALL_MS,
  StopConfirm,
  initialProgress,
  progressFromStatus,
  reduceProgress,
  staleProgress,
  type ProgressState,
} from '../../../src/renderer/download/screens/Progress'
import { AccountBar, SignIn } from '../../../src/renderer/download/screens/SignIn'
import {
  AUTH_LOST_TEXT,
  ABORTED_TEXT,
  DESTINATION_LOST_TEXT,
  DISK_FULL_TEXT,
  DONE_OK_HEADING,
  JOURNAL_ERROR_TEXT,
  LOADING,
  MANIFEST_FAILED_TEXT,
  NOT_FINISHED_HEADING,
  READ_ONLY_NOTE,
  STOP_CONFIRM_TEXT,
} from '../../../src/renderer/download/strings'

const counts = (patch: Partial<Record<EntryOutcome, number>> = {}): Record<EntryOutcome, number> => ({
  downloaded: 0,
  exported: 0,
  already: 0,
  changed_copy: 0,
  duplicate: 0,
  skipped: 0,
  failed: 0,
  ...patch,
})

const done = (patch: Partial<RunDone> = {}): RunDone => ({
  status: 'complete',
  counts: counts({ downloaded: 3 }),
  downloadedBytes: 3_000_000,
  startedAt: '2026-10-27T10:00:00.000Z',
  finishedAt: '2026-10-27T10:05:00.000Z',
  manifestPath: '/Volumes/Disk/Zaloha/_seznam_souboru.csv',
  failed: [],
  skipped: [],
  ...patch,
})

const noop = (): void => {}
function renderDone(d: RunDone, patch: Partial<DoneProps> = {}): string {
  return renderToStaticMarkup(
    <Done done={d} busy={false} error={null} needsSignIn={false} onRetry={noop} onContinue={noop} onShow={noop} onNext={noop} onChooseOther={noop} {...patch} />,
  )
}

describe('Done', () => {
  it('is green only for complete', () => {
    const html = renderDone(done())
    expect(html).toContain(DONE_OK_HEADING)
    expect(html).toContain('banner ok')
    expect(html).not.toContain('banner bad')
    expect(html).not.toContain(NOT_FINISHED_HEADING)
  })

  const others: [RunStatus, Partial<RunDone>, string][] = [
    ['incomplete', { counts: counts({ failed: 2 }), failed: [{ path: 'A/b.mp4', reason: 'soubor se stáhl poškozený' }, { path: 'A/c.mp4', reason: 'x' }] }, 'Stahování NENÍ kompletní: 2 soubory selhaly.'],
    ['destination_lost', {}, DESTINATION_LOST_TEXT],
    ['auth_lost', {}, AUTH_LOST_TEXT],
    ['aborted', {}, ABORTED_TEXT],
    ['journal_error', {}, JOURNAL_ERROR_TEXT],
    ['disk_full', {}, DISK_FULL_TEXT],
  ]
  it.each(others)('is red with its own text for %s', (status, patch, text) => {
    const html = renderDone(done({ status, ...patch }))
    expect(html).toContain('banner bad')
    expect(html).not.toContain('banner ok')
    expect(html).not.toContain(DONE_OK_HEADING)
    expect(html).toContain(NOT_FINISHED_HEADING)
    expect(html).toContain(text)
  })

  it('has the exact Czech texts from the brief', () => {
    expect(DESTINATION_LOST_TEXT).toBe('Externí disk se odpojil. Připoj ho a dej Pokračovat.')
    expect(AUTH_LOST_TEXT).toBe('Přihlášení vypršelo. Přihlas se znovu a dej Pokračovat.')
    expect(ABORTED_TEXT).toBe('Zastaveno. Můžeš pokračovat později.')
    expect(JOURNAL_ERROR_TEXT).toBe('Záznam o stahování v cílové složce je poškozený. Vyber jiné místo.')
    expect(DISK_FULL_TEXT).toBe('Na disku došlo místo. Uvolni místo nebo připoj jiný disk a dej Pokračovat.')
    expect(MANIFEST_FAILED_TEXT).toBe('Seznam souborů se nepodařilo uložit.')
    expect(LOADING).toBe('Načítám…')
  })

  it('is red when the status is complete but a file failed', () => {
    const html = renderDone(done({ status: 'complete', counts: counts({ downloaded: 2, failed: 1 }), failed: [{ path: 'A/x.mp4', reason: 'x' }] }))
    expect(html).not.toContain('banner ok')
    expect(html).not.toContain(DONE_OK_HEADING)
    expect(html).toContain('banner bad')
    expect(html).toContain('Stahování NENÍ kompletní: 1 soubor selhal.')
    expect(html).toContain('Zkusit selhané znovu')
    // main's failed list alone is enough to refuse the green banner
    expect(renderDone(done({ status: 'complete', failed: [{ path: 'A/x.mp4', reason: 'x' }] }))).not.toContain('banner ok')
  })

  it('names the bytes of this run "Nově staženo"', () => {
    const html = renderDone(done())
    expect(html).toContain('Nově staženo')
    expect(html).not.toContain('Staženo v tomto běhu')
  })

  it('pluralizes the failed count', () => {
    expect(renderDone(done({ status: 'incomplete', counts: counts({ failed: 1 }) }))).toContain('Stahování NENÍ kompletní: 1 soubor selhal.')
    expect(renderDone(done({ status: 'incomplete', counts: counts({ failed: 7 }) }))).toContain('Stahování NENÍ kompletní: 7 souborů selhalo.')
  })

  it('lists failed files with the reason given by main', () => {
    const html = renderDone(done({ status: 'incomplete', counts: counts({ failed: 1 }), failed: [{ path: 'Zápas/clip.mp4', reason: 'chyba při zápisu na disk (ENOSPC)' }] }))
    expect(html).toContain('Zápas/clip.mp4')
    expect(html).toContain('chyba při zápisu na disk (ENOSPC)')
    expect(html).toContain('Zkusit selhané znovu')
  })

  it('lists skipped items with their reasons, also on a green run', () => {
    const html = renderDone(done({ counts: counts({ downloaded: 3, skipped: 1 }), skipped: [{ path: 'Zápas/Odkaz', reason: 'zástupce (nestahuje se)' }] }))
    expect(html).toContain('banner ok')
    expect(html).toContain('Přeskočené položky')
    expect(html).toContain('Zápas/Odkaz')
    expect(html).toContain('zástupce (nestahuje se)')
  })

  it('caps each list at 20 lines and points to the manifest for the rest', () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ path: `${prefix}/${i + 1}.mp4`, reason: 'důvod' }))
    const html = renderDone(
      done({ status: 'incomplete', counts: counts({ failed: 25, skipped: 21 }), failed: many(25, 'F'), skipped: many(21, 'S') }),
    )
    expect(html).toContain('F/20.mp4')
    expect(html).not.toContain('F/21.mp4')
    expect(html).toContain('S/20.mp4')
    expect(html).not.toContain('S/21.mp4')
    expect(html).toContain('…a dalších 5 — celý seznam je v souboru _seznam_souboru.csv')
    expect(html).toContain('…a dalších 1 — celý seznam je v souboru _seznam_souboru.csv')
    const noCsv = renderDone(done({ status: 'incomplete', counts: counts({ failed: 25 }), failed: many(25, 'F'), manifestPath: null }))
    expect(noCsv).toContain('…a dalších 5.')
    expect(noCsv).not.toContain('celý seznam')
  })

  it('does not render HTML from a file name', () => {
    const html = renderDone(done({ status: 'incomplete', counts: counts({ failed: 1 }), failed: [{ path: '<img src=x onerror=alert(1)>.mp4', reason: '<b>x</b>' }] }))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>x')
    expect(html).toContain('&lt;img')
  })

  it('shows the manifest file name or says it could not be saved', () => {
    expect(renderDone(done())).toContain('_seznam_souboru.csv')
    const html = renderDone(done({ manifestPath: null }))
    expect(html).toContain(MANIFEST_FAILED_TEXT)
    expect(html).not.toContain('.csv')
  })

  it('shows the counts per outcome', () => {
    const html = renderDone(done({ counts: counts({ downloaded: 12, exported: 2, already: 5, skipped: 1 }) }))
    expect(html).toContain('Staženo')
    expect(html).toContain('>12<')
    expect(html).toContain('Už stažené dřív')
  })

  it('offers the right buttons per status', () => {
    expect(renderDone(done())).toContain('Otevřít ve Finderu')
    expect(renderDone(done())).toContain('Stáhnout další složku')
    expect(renderDone(done())).not.toContain('Pokračovat<')
    expect(renderDone(done({ status: 'aborted' }))).toContain('Pokračovat</button>')
    expect(renderDone(done({ status: 'disk_full' }))).toContain('Pokračovat</button>')
    expect(renderDone(done({ status: 'auth_lost' }), { needsSignIn: true })).toContain('Přihlásit se a pokračovat')
    expect(renderDone(done({ status: 'journal_error' }))).toContain('Vybrat jiné místo')
    expect(renderDone(done({ status: 'journal_error' }))).not.toContain('Pokračovat</button>')
  })

  it('shows an error from a failed retry and disables the buttons while busy', () => {
    const html = renderDone(done({ status: 'aborted' }), { error: 'Stahování už běží.', busy: true })
    expect(html).toContain('Stahování už běží.')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Pokračovat/)
  })
})

const plan: PlanSummary = { rootName: 'Zápasy', fileCount: 1234, folderCount: 12, totalBytes: 210_000_000_000, skipped: 3, duplicateCount: 0, duplicateBytes: 0 }
const preflight = (patch: Partial<PreflightInfo> = {}): PreflightInfo => ({
  destRoot: '/Volumes/Disk/Zápasy',
  state: 'new',
  lastRunAt: null,
  freeBytes: 1_020_000_000_000,
  neededBytes: 210_000_000_000,
  problem: null,
  warning: null,
  ...patch,
})

function renderChoose(patch: Partial<ChooseProps> = {}): string {
  return renderToStaticMarkup(
    <Choose
      scanning={false}
      scanProgress={null}
      scanError={null}
      plan={null}
      preflight={null}
      destError={null}
      startError={null}
      starting={false}
      onScan={noop}
      onPickDestination={noop}
      onStart={noop}
      {...patch}
    />,
  )
}

describe('Choose', () => {
  it('has the link field and the load button', () => {
    const html = renderChoose()
    expect(html).toContain('Načíst složku')
    expect(html).toContain('<input')
  })

  it('shows an indeterminate scanning state with live counts and no percentage', () => {
    const html = renderChoose({ scanning: true, scanProgress: { files: 1234, bytes: 210_000_000_000 } })
    expect(html).toContain('Prohledávám…')
    expect(html).toContain('1\u00a0234 souborů')
    expect(html).toContain('210 GB')
    expect(html).toContain('indeterminate')
    expect(html).not.toContain('%')
    expect(html).not.toContain('role="progressbar"')
  })

  it('shows the summary card after a scan', () => {
    const html = renderChoose({ plan })
    expect(html).toContain('Zápasy')
    expect(html).toContain('1\u00a0234')
    expect(html).toContain('210 GB')
    expect(html).toContain('Vybrat cíl na externím disku')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Start/)
  })

  it('shows a scan error', () => {
    expect(renderChoose({ scanError: 'K téhle složce nemáš přístup.' })).toContain('K téhle složce nemáš přístup.')
  })

  it('enables Start for a clean preflight and shows the new-folder text', () => {
    const html = renderChoose({ plan, preflight: preflight() })
    expect(html).toContain('Složka se založí: /Volumes/Disk/Zápasy')
    expect(html).toContain('1,02 TB')
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Start/)
    expect(html).toContain('>Start</button>')
  })

  it('disables Start and shows the problem in red', () => {
    const html = renderChoose({ plan, preflight: preflight({ problem: 'Na disku není dost místa.' }) })
    expect(html).toContain('Na disku není dost místa.')
    expect(html).toContain('callout bad')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Start/)
  })

  it('shows a warning in amber and still allows Start', () => {
    const html = renderChoose({ plan, preflight: preflight({ warning: 'Nepodařilo se zjistit formát disku.' }) })
    expect(html).toContain('Nepodařilo se zjistit formát disku.')
    expect(html).toContain('callout warn')
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Start/)
  })

  it('explains resume and foreign folders', () => {
    const resume = renderChoose({ plan, preflight: preflight({ state: 'resume', lastRunAt: new Date(2026, 9, 20, 12, 0).toISOString() }) })
    expect(resume).toContain('Navazuji na stahování z 20. 10. 2026.')
    const foreign = renderChoose({ plan, preflight: preflight({ state: 'foreign' }) })
    expect(foreign).toContain('Ve složce už jsou jiné soubory. Nic z nich se nepřepíše, stažené soubory přibudou vedle.')
  })

  it('does not render HTML from a folder name or path', () => {
    const html = renderChoose({ plan: { ...plan, rootName: '<script>alert(1)</script>' }, preflight: preflight({ destRoot: '/Volumes/<b>x</b>' }) })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>x')
  })

  it('fills the link field from initialLink', () => {
    expect(renderChoose({ initialLink: 'https://drive.google.com/drive/folders/abc' })).toContain('value="https://drive.google.com/drive/folders/abc"')
  })

  it('disables the destination button while a start is in progress', () => {
    const html = renderChoose({ plan, preflight: preflight(), starting: true })
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Vybrat jiný cíl/)
    expect(renderChoose({ plan, preflight: preflight() })).not.toMatch(/<button[^>]*disabled[^>]*>Vybrat jiný cíl/)
  })

  it('shows skipped items', () => {
    expect(renderChoose({ plan })).toContain('Přeskočeno')
  })

  it('says how many duplicates are downloaded only once, and nothing when there are none', () => {
    const html = renderChoose({ plan: { ...plan, duplicateCount: 37, duplicateBytes: 52_000_000_000 } })
    expect(html).toContain('Duplikáty: 37 souborů (52 GB) má stejný obsah')
    expect(renderChoose({ plan })).not.toContain('Duplikáty')
  })
})

const progressState = (patch: Partial<ProgressState> = {}): ProgressState => ({ ...initialProgress(1234), ...patch })

describe('Progress', () => {
  it('keeps the not-finished banner', () => {
    const html = renderToStaticMarkup(<Progress progress={progressState()} onAbort={noop} />)
    expect(html).toContain(NOT_FINISHED_HEADING)
    expect(NOT_FINISHED_HEADING).toBe('Stahování NENÍ dokončené')
    expect(html).toContain('not-finished')
  })

  it('shows bytes, files, the current path, speed and ETA', () => {
    const html = renderToStaticMarkup(
      <Progress
        progress={progressState({ doneBytes: 105_000_000_000, totalBytes: 210_000_000_000, filesDone: 600, currentPath: 'Zápasy/Den 1/IMG_0001.MOV', speed: 85_300_000, etaSeconds: 8100 })}
        onAbort={noop}
      />,
    )
    expect(html).toContain('105 GB')
    expect(html).toContain('210 GB')
    expect(html).toContain('50 %')
    expect(html).toContain('600')
    expect(html).toContain('1\u00a0234')
    expect(html).toContain('Zápasy/Den 1/IMG_0001.MOV')
    expect(html).toContain('85,3 MB/s')
    expect(html).toContain('2 h 15 min')
  })

  it('shows a dash instead of speed and ETA before they are known', () => {
    const html = renderToStaticMarkup(<Progress progress={progressState()} onAbort={noop} />)
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('Infinity')
  })

  it('shows a dash for speed and ETA when the byte events stalled', () => {
    const html = renderToStaticMarkup(<Progress progress={progressState({ stalled: true })} onAbort={noop} />)
    expect(html).toContain('Rychlost:</span> —')
    expect(html).toContain('Zbývá:</span> —')
    expect(html).not.toContain('zjišťuji')
  })

  it('has a Zastavit button', () => {
    expect(renderToStaticMarkup(<Progress progress={progressState()} onAbort={noop} />)).toContain('Zastavit')
  })

  it('does not render HTML from a file path', () => {
    const html = renderToStaticMarkup(<Progress progress={progressState({ currentPath: '<img src=x onerror=1>' })} onAbort={noop} />)
    expect(html).not.toContain('<img')
  })
})

describe('StopConfirm', () => {
  it('explains that the download can continue later', () => {
    const html = renderToStaticMarkup(<StopConfirm onConfirm={noop} onCancel={noop} />)
    expect(html).toContain(STOP_CONFIRM_TEXT)
    expect(STOP_CONFIRM_TEXT).toContain('můžeš pokračovat později')
    expect(html).toContain('Ano, zastavit')
    expect(html).toContain('Pokračovat ve stahování')
  })
})

function findButton(node: ReactNode, text: string): { autoFocus?: boolean } | null {
  if (!isValidElement(node)) return null
  const props = node.props as { children?: ReactNode; autoFocus?: boolean }
  if (node.type === 'button' && props.children === text) return props
  const children = Array.isArray(props.children) ? (props.children as ReactNode[]) : [props.children]
  for (const child of children) {
    const found = findButton(child, text)
    if (found !== null) return found
  }
  return null
}

describe('StopConfirm focus', () => {
  it('focuses the safe choice, not the destructive one', () => {
    const tree = StopConfirm({ onConfirm: noop, onCancel: noop })
    expect(findButton(tree, 'Pokračovat ve stahování')?.autoFocus).toBe(true)
    expect(findButton(tree, 'Ano, zastavit')?.autoFocus).toBeUndefined()
  })
})

describe('reduceProgress', () => {
  it('tracks bytes, files and the current path', () => {
    let s = initialProgress(3)
    s = reduceProgress(s, { type: 'file_start', index: 0, entry: entry('A/1.mp4', 100) }, 0)
    expect(s.currentPath).toBe('A/1.mp4')
    s = reduceProgress(s, { type: 'bytes', doneBytes: 50, totalBytes: 300 }, 1000)
    expect(s.doneBytes).toBe(50)
    expect(s.totalBytes).toBe(300)
    s = reduceProgress(s, { type: 'file_done', result: result('A/1.mp4', 'downloaded', 100) }, 2000)
    expect(s.filesDone).toBe(1)
  })

  it('starts from the run status snapshot of a run already in progress', () => {
    const p = progressFromStatus({ running: true, filesDone: 4, filesTotal: 10, doneBytes: 500, totalBytes: 1000, currentPath: 'Z/e.mp4' })
    expect(p).toMatchObject({ filesDone: 4, filesTotal: 10, doneBytes: 500, totalBytes: 1000, currentPath: 'Z/e.mp4', speed: null })
    // The next bytes event measures from here, not from 0: no speed spike.
    const next = reduceProgress(p, { type: 'bytes', doneBytes: 600, totalBytes: 1000 }, 1000)
    expect(next.doneBytes).toBe(600)
    expect(next.speed).toBeNull()
  })

  it('does not count skipped entries as files', () => {
    let s = initialProgress(3)
    s = reduceProgress(s, { type: 'file_done', result: result('A/x.gdoc', 'skipped', 0) }, 0)
    expect(s.filesDone).toBe(0)
  })

  it('does not count duplicates as files (they are not part of the file total)', () => {
    let s = initialProgress(1)
    s = reduceProgress(s, { type: 'file_done', result: result('A/kopie.mp4', 'duplicate', 0) }, 0)
    expect(s.filesDone).toBe(0)
  })

  it('computes speed and ETA from transferred bytes over a window', () => {
    let s = initialProgress(3)
    s = reduceProgress(s, { type: 'bytes', doneBytes: 0, totalBytes: 1000 }, 0)
    s = reduceProgress(s, { type: 'bytes', doneBytes: 200, totalBytes: 1000 }, 2000)
    expect(s.speed).toBe(100)
    expect(s.etaSeconds).toBe(8)
  })

  /** A finished download at 100 B/s: speed 100 after file A (size 1000). */
  function afterFileA(): ProgressState {
    let s = initialProgress(5, 100_000)
    s = reduceProgress(s, { type: 'file_start', index: 0, entry: entry('A/a.mp4', 1000) }, 0)
    s = reduceProgress(s, { type: 'bytes', doneBytes: 500, totalBytes: 100_000 }, 5000)
    // the downloader emits the final bytes event BEFORE file_done
    s = reduceProgress(s, { type: 'bytes', doneBytes: 1000, totalBytes: 100_000 }, 10_000)
    s = reduceProgress(s, { type: 'file_done', result: result('A/a.mp4', 'downloaded', 1000) }, 10_000)
    return s
  }

  it('measures a normal download', () => {
    expect(afterFileA().speed).toBeCloseTo(100, 5)
  })

  it('does not spike when a resumed file turns out to be already on disk (bytes jump comes before file_done)', () => {
    let s = afterFileA()
    s = reduceProgress(s, { type: 'file_start', index: 1, entry: entry('A/old.mp4', 50_000) }, 10_100)
    s = reduceProgress(s, { type: 'bytes', doneBytes: 51_000, totalBytes: 100_000 }, 10_100)
    // between the jump and file_done the speed is held, not recomputed from the jump
    expect(s.speed).toBeCloseTo(100, 5)
    s = reduceProgress(s, { type: 'file_done', result: result('A/old.mp4', 'already', 50_000) }, 10_100)
    expect(s.speed).toBeGreaterThan(90)
    expect(s.speed).toBeLessThan(110)
    expect(s.untransferred).toBe(50_000)
    // the ETA follows the real speed (49 000 bytes left at ~100 B/s), not the jump
    expect(s.etaSeconds).toBeGreaterThan(400)
    expect(s.etaSeconds).toBeLessThan(600)
  })

  it('a run of many already-downloaded files never shows a spike', () => {
    let s = afterFileA()
    let done = 1000
    for (let i = 0; i < 20; i++) {
      const name = `A/old${i}.mp4`
      s = reduceProgress(s, { type: 'file_start', index: i + 1, entry: entry(name, 1_000_000) }, 11_000 + i)
      done += 1_000_000
      s = reduceProgress(s, { type: 'bytes', doneBytes: done, totalBytes: 100_000_000 }, 11_000 + i)
      s = reduceProgress(s, { type: 'file_done', result: result(name, 'already', 1_000_000) }, 11_000 + i)
      expect(s.speed ?? 0).toBeLessThan(1000)
    }
  })

  it('counts only the bytes really received of a failed file as transferred', () => {
    let s = afterFileA()
    s = reduceProgress(s, { type: 'file_start', index: 1, entry: entry('A/bad.mp4', 10_000) }, 11_000)
    s = reduceProgress(s, { type: 'bytes', doneBytes: 1300, totalBytes: 100_000 }, 12_000)
    // failure: the downloader still adds the planned size and emits the final bytes before file_done
    s = reduceProgress(s, { type: 'bytes', doneBytes: 11_000, totalBytes: 100_000 }, 12_100)
    s = reduceProgress(s, { type: 'file_done', result: result('A/bad.mp4', 'failed', 10_000) }, 12_100)
    expect(s.untransferred).toBe(9700)
    // 300 bytes were received in 2.1 s since the end of A: no spike
    expect(s.speed ?? 0).toBeLessThan(200)
  })

  it('clears speed and ETA after a stall and measures again afterwards', () => {
    let s = afterFileA()
    expect(staleProgress(s, 10_000 + STALL_MS - 1)).toBe(s)
    const stalled = staleProgress(s, 10_000 + STALL_MS + 1)
    expect(stalled.speed).toBeNull()
    expect(stalled.etaSeconds).toBeNull()
    expect(stalled.stalled).toBe(true)
    // nothing left to clear: same object, no re-render
    expect(staleProgress(stalled, 10_000 + STALL_MS + 5000)).toBe(stalled)
    s = reduceProgress(stalled, { type: 'bytes', doneBytes: 1100, totalBytes: 100_000 }, 40_000)
    expect(s.stalled).toBe(false)
    s = reduceProgress(s, { type: 'bytes', doneBytes: 1300, totalBytes: 100_000 }, 42_000)
    expect(s.speed).toBeCloseTo(100, 5)
  })

  it('never stalls before the first byte event', () => {
    const s = initialProgress(3)
    expect(staleProgress(s, 1e9)).toBe(s)
  })

  it('has no speed before two samples span a second', () => {
    let s = initialProgress(3)
    s = reduceProgress(s, { type: 'bytes', doneBytes: 10, totalBytes: 1000 }, 0)
    expect(s.speed).toBeNull()
    expect(s.etaSeconds).toBeNull()
  })
})

function entry(drivePath: string, size: number) {
  return {
    fileId: drivePath,
    drivePath,
    localRelPath: drivePath,
    kind: 'file' as const,
    size,
    md5: null,
    mimeType: 'video/mp4',
    exportMime: null,
    modifiedTime: '2026-10-27T10:00:00.000Z',
    skipReason: null,
    blocked: false,
    duplicate: false,
  }
}

function result(drivePath: string, outcome: EntryOutcome, size: number) {
  return { entry: entry(drivePath, size), outcome, localRelPath: drivePath, md5: null, bytes: size, reason: null }
}

describe('SignIn', () => {
  it('has the Google button and the read-only note', () => {
    const html = renderToStaticMarkup(<SignIn busy={false} error={null} onSignIn={noop} />)
    expect(html).toContain('Přihlásit se přes Google')
    expect(html).toContain(READ_ONLY_NOTE)
    expect(READ_ONLY_NOTE).toBe('Aplikace má jen oprávnění číst. Na Disku nic nezmění.')
  })

  it('shows a sign-in error and disables the button while busy', () => {
    const html = renderToStaticMarkup(<SignIn busy={true} error="Přihlášení bylo zrušeno." onSignIn={noop} />)
    expect(html).toContain('Přihlášení bylo zrušeno.')
    expect(html).toMatch(/<button[^>]*disabled/)
  })
})

describe('AccountBar', () => {
  it('shows the e-mail and an enabled sign-out button', () => {
    const html = renderToStaticMarkup(<AccountBar email="jan@example.com" running={false} onSignOut={noop} />)
    expect(html).toContain('jan@example.com')
    expect(html).toContain('Odhlásit')
    expect(html).not.toMatch(/<button[^>]*disabled/)
  })

  it('disables sign-out during a run', () => {
    const html = renderToStaticMarkup(<AccountBar email="jan@example.com" running={true} onSignOut={noop} />)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Odhlásit/)
  })

  it('does not render HTML from the e-mail', () => {
    expect(renderToStaticMarkup(<AccountBar email="<b>x</b>@a.cz" running={false} onSignOut={noop} />)).not.toContain('<b>x')
  })
})
