import { useEffect, useId, useState } from 'react'
import { parseRoster } from '../../core/roster'
import type { CardDetected, Settings } from '../../shared/ipc-types'
import { initialChoice, reconcileChoice, type EventChoice, type EventPreset } from '../eventChoice'
import { defaultEventName, drivePath, formatBytes, formatDateRange, plural } from '../format'
import { BACKUP_ONLY_HINT, TOOLS_MISSING_MESSAGE } from '../strings'

/** `sort: false` = back up without the AI (no API key): everything goes to `_nezařazeno`. */
export type StartForm = { eventName: string; isNew: boolean; templateId: string; rosterText: string; sort: boolean }

type Props = {
  card: CardDetected
  preset: EventPreset | undefined
  settings: Settings
  hasKey: boolean
  /** false: ffprobe/ffmpeg did not run at startup; nothing can be started. */
  toolsOk: boolean
  /** Other cards waiting behind this one. */
  waiting: number
  /** Resolves to an error text, or null when the run was started. */
  onStart(form: StartForm): Promise<string | null>
  onCancel(): void
  onSettings(settings: Settings): void
  onOpenSettings(): void
}

const NEW_ROSTER = '__new__'

function nameProblem(name: string): string | null {
  const n = name.trim()
  if (n === '') return 'Zadej název akce.'
  if (/[\\/]/.test(n) || n.startsWith('.')) return 'Název nesmí obsahovat lomítka ani začínat tečkou.'
  return null
}

export function NewCard({ card, preset, settings, hasKey, toolsOk, waiting, onStart, onCancel, onSettings, onOpenSettings }: Props) {
  const ids = { mode: useId(), existing: useId(), name: useId(), template: useId(), roster: useId(), team: useId(), text: useId() }
  const firstDate = card.firstDate !== null && !Number.isNaN(new Date(card.firstDate).getTime()) ? new Date(card.firstDate) : new Date()

  const [events, setEvents] = useState<string[] | null>(null)
  const [choice, setChoice] = useState<EventChoice>(() => initialChoice(preset, defaultEventName(firstDate)))
  const { mode, existing, newName } = choice
  const [templateId, setTemplateId] = useState(
    settings.templates.some((t) => t.id === settings.lastTemplateId) ? settings.lastTemplateId : (settings.templates[0]?.id ?? ''),
  )
  const [rosterChoice, setRosterChoice] = useState('')
  const [team, setTeam] = useState('')
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // the event list belongs to the destination folder, so it is reloaded whenever that folder changes
  useEffect(() => {
    let alive = true
    setEvents(null)
    void window.api.listEvents().then((list) => {
      if (!alive) return
      setEvents(list)
      setChoice((current) => reconcileChoice(current, preset, list))
    })
    return () => {
      alive = false
    }
  }, [settings.rootDir])

  const pickRoot = async (): Promise<void> => {
    setError('')
    const dir = await window.api.pickRootFolder()
    if (dir === null) return
    const result = await window.api.setSettings({ rootDir: dir })
    if (result.ok) onSettings(result.settings)
    else setError(result.error)
  }

  const teams = Object.keys(settings.rosters).sort((a, b) => a.localeCompare(b, 'cs'))
  const savedText = rosterChoice !== '' && rosterChoice !== NEW_ROSTER ? (settings.rosters[rosterChoice] ?? '') : ''
  const rosterText = rosterChoice === NEW_ROSTER ? pasted : savedText
  const players = parseRoster(rosterText).length

  const eventName = mode === 'new' ? newName.trim() : existing
  const problem = mode === 'new' ? nameProblem(newName) : existing === '' ? 'Vyber akci.' : null
  const noRoot = settings.rootDir === null
  const formReady = toolsOk && !busy && !noRoot && problem === null && templateId !== ''
  const canStart = formReady && hasKey
  const canBackupOnly = formReady && !hasKey

  const submit = async (sort: boolean): Promise<void> => {
    if (sort ? !canStart : !canBackupOnly) return
    setBusy(true)
    setError('')
    try {
      const teamName = team.trim()
      if (rosterChoice === NEW_ROSTER && teamName !== '' && pasted.trim() !== '') {
        const saved = await window.api.setSettings({ rosters: { ...settings.rosters, [teamName]: pasted } })
        if (!saved.ok) {
          setError(saved.error)
          return
        }
        onSettings(saved.settings)
      }
      const failure = await onStart({ eventName, isNew: mode === 'new', templateId, rosterText, sort })
      if (failure !== null) setError(failure)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Zálohu se nepodařilo spustit.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stack">
      <h1>Nová karta</h1>

      <div className="card summary">
        <dl>
          <div>
            <dt>Karta</dt>
            <dd>{card.volumeName}</dd>
          </div>
          <div>
            <dt>Klipů</dt>
            <dd>
              {card.videos} {plural(card.videos, 'klip', 'klipy', 'klipů')}
            </dd>
          </div>
          <div>
            <dt>Velikost</dt>
            <dd>{formatBytes(card.bytes)}</dd>
          </div>
          <div className="wide">
            <dt>Natočeno</dt>
            <dd>{formatDateRange(card.firstDate, card.lastDate)}</dd>
          </div>
        </dl>
        {waiting > 0 && <p className="muted small">Za touhle kartou čeká ještě {waiting} {plural(waiting, 'další', 'další', 'dalších')}.</p>}
      </div>

      {!toolsOk && (
        <p className="callout bad" role="alert">
          {TOOLS_MISSING_MESSAGE}
        </p>
      )}

      {!hasKey && (
        <div className="callout warn">
          <p>Chybí klíč ke Claude, bez něj se klipy nedají třídit. Zadej ho v nastavení.</p>
          <p className="small">{BACKUP_ONLY_HINT}</p>
          <button type="button" onClick={onOpenSettings}>
            Otevřít nastavení
          </button>
        </div>
      )}

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(true)
        }}
      >
        <fieldset className="card">
          <legend>Kam nahrát</legend>
          {noRoot ? (
            <p className="muted small">Vyber složku na Google Disku, do které se má akce uložit.</p>
          ) : (
            <p className="path">{drivePath(settings.rootDir ?? '')}</p>
          )}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => void pickRoot()} disabled={busy}>
              {noRoot ? 'Vybrat složku' : 'Změnit složku'}
            </button>
          </div>
        </fieldset>

        <fieldset className="card">
          <legend>Akce</legend>
          <div className="radio-row">
            <label>
              <input
                type="radio"
                name={ids.mode}
                checked={mode === 'existing'}
                disabled={events === null || events.length === 0}
                onChange={() => setChoice((c) => ({ ...c, mode: 'existing' }))}
              />
              Existující akce
            </label>
            <select
              id={ids.existing}
              aria-label="Existující akce"
              value={existing}
              disabled={mode !== 'existing'}
              onChange={(e) => setChoice((c) => ({ ...c, existing: e.target.value }))}
            >
              {(events ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          {events !== null && events.length === 0 && !noRoot && <p className="muted small">Ve složce na Disku zatím žádná akce není.</p>}
          <div className="radio-row">
            <label>
              <input type="radio" name={ids.mode} checked={mode === 'new'} onChange={() => setChoice((c) => ({ ...c, mode: 'new' }))} />
              Nová akce
            </label>
            <input
              id={ids.name}
              type="text"
              aria-label="Název nové akce"
              value={newName}
              disabled={mode !== 'new'}
              onChange={(e) => setChoice((c) => ({ ...c, newName: e.target.value }))}
              spellCheck={false}
            />
          </div>
          {problem !== null && mode === 'new' && newName.trim() !== '' && <p className="field-error">{problem}</p>}
        </fieldset>

        <fieldset className="card">
          <legend>Šablona kategorií</legend>
          <select id={ids.template} aria-label="Šablona kategorií" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {settings.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </fieldset>

        <fieldset className="card">
          <legend>Soupiska (nepovinná)</legend>
          <p className="muted small">S číslem na dresu a soupiskou umí třídění připsat do názvu příjmení hráče.</p>
          <select id={ids.roster} aria-label="Soupiska" value={rosterChoice} onChange={(e) => setRosterChoice(e.target.value)}>
            <option value="">Bez soupisky</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value={NEW_ROSTER}>Nová soupiska…</option>
          </select>
          {savedText !== '' && (
            <p className="muted small">
              {players} {plural(players, 'hráč', 'hráči', 'hráčů')} v uložené soupisce.
            </p>
          )}
          {rosterChoice === NEW_ROSTER && (
            <div className="stack tight">
              <label htmlFor={ids.team}>Název týmu (pod ním se soupiska uloží)</label>
              <input id={ids.team} type="text" value={team} onChange={(e) => setTeam(e.target.value)} placeholder="např. Slavia" />
              <label htmlFor={ids.text}>Soupiska — každý hráč na jeden řádek, např. „9 Kačor“</label>
              <textarea id={ids.text} rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false} />
              <p className="muted small">
                Rozpoznáno hráčů: {players}.
                {team.trim() !== '' && pasted.trim() !== '' ? ' Soupiska se uloží pro příště.' : ' Bez názvu týmu se soupiska použije jen teď a neuloží se.'}
              </p>
            </div>
          )}
        </fieldset>

        {error && (
          <p className="callout bad" role="alert">
            {error}
          </p>
        )}

        <div className="actions sticky">
          {hasKey ? (
            <button type="submit" className="primary big" disabled={!canStart}>
              {busy ? 'Spouštím…' : 'Start'}
            </button>
          ) : (
            <button type="button" className="primary big" disabled={!canBackupOnly} onClick={() => void submit(false)}>
              {busy ? 'Spouštím…' : 'Zálohovat bez třídění'}
            </button>
          )}
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            Zrušit
          </button>
        </div>
      </form>
    </section>
  )
}
