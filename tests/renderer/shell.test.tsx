import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GoogleAccountView } from '../../src/renderer/GoogleAccount'
import { Home } from '../../src/renderer/Home'
import { ShellLayout } from '../../src/renderer/Shell'
import { cardsStatusText, downloadStatusText, initialShell, reduceShell, type ShellState } from '../../src/renderer/shell-state'

const at = (view: ShellState['view'], returnTo: ShellState['returnTo'] = 'home'): ShellState => ({ view, returnTo })

describe('reduceShell', () => {
  it('starts on home', () => {
    expect(initialShell()).toEqual(at('home'))
  })
  it('card arrival switches to cards from home and from download', () => {
    expect(reduceShell(at('home'), { type: 'cardArrived' }).view).toBe('cards')
    expect(reduceShell(at('download'), { type: 'cardArrived' }).view).toBe('cards')
  })
  it('card arrival does not leave settings but closing settings shows the card', () => {
    const arrived = reduceShell(at('settings', 'download'), { type: 'cardArrived' })
    expect(arrived).toEqual(at('settings', 'cards'))
    expect(reduceShell(arrived, { type: 'closeSettings' }).view).toBe('cards')
  })
  it('settings returns to where it was opened', () => {
    const opened = reduceShell(at('cards'), { type: 'openSettings' })
    expect(opened).toEqual(at('settings', 'cards'))
    expect(reduceShell(opened, { type: 'closeSettings' }).view).toBe('cards')
    expect(reduceShell(at('settings', 'cards'), { type: 'openSettings' })).toEqual(at('settings', 'cards'))
  })
  it('opens a mode or home', () => {
    expect(reduceShell(at('home'), { type: 'open', view: 'download' }).view).toBe('download')
    expect(reduceShell(at('cards'), { type: 'open', view: 'home' }).view).toBe('home')
  })
})

describe('status texts', () => {
  it('home shows a running download', () => {
    expect(downloadStatusText({ doneBytes: 50, totalBytes: 100 })).toBe('Stahuje se – 50 %')
    expect(downloadStatusText({ doneBytes: 1, totalBytes: 3 })).toBe('Stahuje se – 33 %')
    expect(downloadStatusText({ doneBytes: 0, totalBytes: 0 })).toBe('Stahuje se – 0 %')
    expect(downloadStatusText(null)).toBeNull()
  })
  it('cards status names the card and the queue', () => {
    expect(cardsStatusText({ activeVolume: 'SONY_A75', activeCount: 1, pending: 0 })).toBe('Karta SONY_A75 – zálohuje se')
    expect(cardsStatusText({ activeVolume: 'SONY_A75', activeCount: 3, pending: 0 })).toBe('Karta SONY_A75 – zálohuje se (další ve frontě: 2)')
    expect(cardsStatusText({ activeVolume: null, activeCount: 0, pending: 1 })).toBe('Čeká nová karta')
    expect(cardsStatusText({ activeVolume: null, activeCount: 0, pending: 0 })).toBeNull()
  })
})

describe('Home', () => {
  it('home shows both choices', () => {
    const html = renderToStaticMarkup(<Home downloadStatus={null} cardsStatus={null} onDownload={() => {}} onCards={() => {}} />)
    expect(html).toContain('Stáhnout z Drivu')
    expect(html).toContain('Celá složka z Google Disku na externí disk')
    expect(html).toContain('Nahrát kartu')
    expect(html).toContain('Roztřídit, pojmenovat a nahrát na Drive')
  })
  it('shows the status of a running mode', () => {
    const html = renderToStaticMarkup(
      <Home downloadStatus="Stahuje se – 34 %" cardsStatus="Karta SONY_A75 – zálohuje se" onDownload={() => {}} onCards={() => {}} />,
    )
    expect(html).toContain('Stahuje se – 34 %')
    expect(html).toContain('Karta SONY_A75 – zálohuje se')
  })
})

describe('ShellLayout', () => {
  const render = (state: ShellState): string =>
    renderToStaticMarkup(
      <ShellLayout
        state={state}
        home={<p>HOME</p>}
        settings={<p>SETTINGS</p>}
        download={<input defaultValue="https://drive.google.com/drive/folders/abc" />}
        cards={<p>CARDS</p>}
        onHome={() => {}}
        onSettings={() => {}}
      />,
    )
  it('card arrival switches to cards and keeps download mounted', () => {
    const html = render(reduceShell(at('download'), { type: 'cardArrived' }))
    expect(html).toMatch(/<div class="mode mode-download" hidden="">/)
    expect(html).toContain('https://drive.google.com/drive/folders/abc')
    expect(html).toMatch(/<div class="mode mode-cards">/)
    expect(html).not.toContain('HOME')
  })
  it('home hides both modes but keeps them mounted', () => {
    const html = render(at('home'))
    expect(html).toContain('HOME')
    expect(html).toMatch(/<div class="mode mode-download" hidden="">/)
    expect(html).toMatch(/<div class="mode mode-cards" hidden="">/)
    expect(html).toContain('Sportivea Záloha')
    expect(html).toContain('Nastavení')
  })
  it('every view but home has a visible way back to home', () => {
    expect(render(at('download'))).toContain('← Úvod</button>')
    expect(render(at('cards'))).toContain('← Úvod</button>')
    expect(render(at('settings'))).toContain('← Úvod</button>')
    expect(render(at('home'))).not.toContain('← Úvod')
  })
  it('settings view hides the Nastavení link', () => {
    const html = render(at('settings'))
    expect(html).toContain('SETTINGS')
    expect(html).not.toContain('>Nastavení</button>')
  })
})

describe('GoogleAccountView', () => {
  it('sign-out error is shown', () => {
    const html = renderToStaticMarkup(
      <GoogleAccountView email="video@sportivea.cz" error="Během stahování se nejde odhlásit." busy={false} running={false} onSignOut={() => {}} />,
    )
    expect(html).toContain('video@sportivea.cz')
    expect(html).toContain('Během stahování se nejde odhlásit.')
    expect(html).toContain('Odhlásit')
  })
  it('sign-out is disabled while a download runs', () => {
    const html = renderToStaticMarkup(<GoogleAccountView email="video@sportivea.cz" error={null} busy={false} running={true} onSignOut={() => {}} />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Odhlásit<\/button>/)
    expect(html).toContain('Během stahování se odhlásit nejde.')
  })
  it('shows when nobody is signed in', () => {
    const html = renderToStaticMarkup(<GoogleAccountView email={null} error={null} busy={false} running={false} onSignOut={() => {}} />)
    expect(html).toContain('Nepřihlášeno')
    expect(html).not.toContain('Odhlásit')
  })
})
