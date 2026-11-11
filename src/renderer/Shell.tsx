import { useCallback, useReducer, useState } from 'react'
import { CardsMode } from './cards/CardsMode'
import { DownloadMode } from './download/DownloadMode'
import { Home } from './Home'
import { SettingsView } from './SettingsView'
import { initialShell, reduceShell, type ShellState } from './shell-state'
import { APP_NAME, BACK_HOME, SETTINGS_LINK } from './strings'

type LayoutProps = {
  state: ShellState
  home: React.ReactNode
  settings: React.ReactNode
  download: React.ReactNode
  cards: React.ReactNode
  onHome: () => void
  onSettings: () => void
}

/** Top bar plus the current view. Both modes are always rendered (hidden when inactive) so that their state survives. */
export function ShellLayout({ state, home, settings, download, cards, onHome, onSettings }: LayoutProps) {
  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={onHome}>
          {APP_NAME}
        </button>
        <nav className="topbar-links">
          {state.view !== 'home' && (
            <button type="button" className="link" onClick={onHome}>
              {BACK_HOME}
            </button>
          )}
          {state.view !== 'settings' && (
            <button type="button" className="link" onClick={onSettings}>
              {SETTINGS_LINK}
            </button>
          )}
        </nav>
      </header>
      <main className="content">
        {state.view === 'home' && home}
        {state.view === 'settings' && settings}
        <div className="mode mode-download" hidden={state.view !== 'download'}>
          {download}
        </div>
        <div className="mode mode-cards" hidden={state.view !== 'cards'}>
          {cards}
        </div>
      </main>
    </div>
  )
}

export function Shell() {
  const [state, dispatch] = useReducer(reduceShell, undefined, initialShell)
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null)
  const [cardsStatus, setCardsStatus] = useState<string | null>(null)
  const openSettings = useCallback(() => dispatch({ type: 'openSettings' }), [])
  const cardArrived = useCallback(() => dispatch({ type: 'cardArrived' }), [])

  return (
    <ShellLayout
      state={state}
      onHome={() => dispatch({ type: 'open', view: 'home' })}
      onSettings={openSettings}
      home={
        <Home
          downloadStatus={downloadStatus}
          cardsStatus={cardsStatus}
          onDownload={() => dispatch({ type: 'open', view: 'download' })}
          onCards={() => dispatch({ type: 'open', view: 'cards' })}
        />
      }
      settings={<SettingsView onBack={() => dispatch({ type: 'closeSettings' })} />}
      download={<DownloadMode visible={state.view === 'download'} onStatus={setDownloadStatus} />}
      cards={
        <CardsMode
          visible={state.view === 'cards'}
          onStatus={setCardsStatus}
          onCardArrived={cardArrived}
          onOpenSettings={openSettings}
        />
      }
    />
  )
}
