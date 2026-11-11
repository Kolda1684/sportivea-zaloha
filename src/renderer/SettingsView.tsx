import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../shared/cards-ipc'
import { api as cardsApi } from './cards/api'
import { SettingsScreen } from './cards/screens/Settings'
import { GoogleAccount } from './GoogleAccount'
import { GOOGLE_SECTION } from './strings'

/** One settings screen: the Google account (downloads) above everything Třídění karet had. */
export function SettingsView({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [hasKey, setHasKey] = useState(false)

  const reload = useCallback(async () => {
    setSettings(await cardsApi().getSettings())
    setHasKey(await cardsApi().hasApiKey())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  if (settings === null) return <p className="muted">Načítám…</p>
  return (
    <SettingsScreen
      settings={settings}
      hasKey={hasKey}
      onSettings={setSettings}
      onKeySaved={() => setHasKey(true)}
      onBack={onBack}
      before={
        <div className="card stack tight">
          <h2>{GOOGLE_SECTION}</h2>
          <p className="muted small">Účet pro stahování z Google Disku (jen pro čtení).</p>
          <GoogleAccount />
        </div>
      }
    />
  )
}
