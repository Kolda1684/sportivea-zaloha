import { useEffect, useId, useState } from 'react'
import { parseRoster } from '../../core/roster'
import type { CardDetected, Settings } from '../../shared/ipc-types'
import { defaultEventName, formatBytes, formatDateRange, plural } from '../format'

export type StartForm = { eventName: string; isNew: boolean; templateId: string; rosterText: string }

type Props = {
  card: CardDetected
  preset: { eventName: string; isNew: boolean } | undefined
  settings: Settings
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

export function NewCard({ card, preset, settings, waiting, onStart, onCancel, onSettings, onOpenSettings }: Props) {
  const ids = { mode: useId(), existing: useId(), name: useId(), template: useId(), roster: useId(), team: useId(), text: useId() }
  const firstDate = card.firstDate !== null && !Number.isNaN(new Date(card.firstDate).getTime()) ? new Date(card.firstDate) : new Date()

  const [events, setEvents] = useState<string[] | null>(null)
  const [mode, setMode] = useState<'existing' | 'new'>(preset && !preset.isNew ? 'existing' : 'new')
  const [existing, setExisting] = useState(preset && !preset.isNew ? preset.eventName : '')
  const [newName, setNewName] = useState(preset?.isNew ? preset.eventName : defaultEventName(firstDate))
  const [templateId, setTemplateId] = useState(
    settings.templates.some((t) => t.id === settings.lastTemplateId) ? settings.lastTemplateId : (settings.templates[0]?.id ?? ''),
  )
  const [rosterChoice, setRosterChoice] = useState('')
  const [team, setTeam] = useState('')
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.listEvents().then((list) => {
      if (!alive) return
      setEvents(list)
      setExisting((current) => (current !== '' && list.includes(current) ? current : (list[0] ?? '')))
      if (list.length === 0) setMode('new')
    })
    return () => {
      alive = false
    }
  }, [])

  const teams = Object.keys(settings.rosters).sort((a, b) => a.localeCompare(b, 'cs'))
  const savedText = rosterChoice !== '' && rosterChoice !== NEW_ROSTER ? (settings.rosters[rosterChoice] ?? '') : ''
  const rosterText = rosterChoice === NEW_ROSTER ? pasted : savedText
  const players = parseRoster(rosterText).length

  const eventName = mode === 'new' ? newName.trim() : existing
  const problem = mode === 'new' ? nameProblem(newName) : existing === '' ? 'Vyber akci.' : null
  const noRoot = settings.rootDir === null
  const canStart = !busy && !noRoot && problem === null && templateId !== ''

  const submit = async (): Promise<void> => {
    if (!canStart) return
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
      const failure = await onStart({ eventName, isNew: mode === 'new', templateId, rosterText })
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

      {noRoot && (
        <div className="callout warn">
          <p>Nejdřív vyber složku na Google Disku, do které se budou ukládat akce.</p>
          <button type="button" onClick={onOpenSettings}>
            Otevřít nastavení
          </button>
        </div>
      )}

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <fieldset className="card">
          <legend>Akce</legend>
          <div className="radio-row">
            <label>
              <input
                type="radio"
                name={ids.mode}
                checked={mode === 'existing'}
                disabled={events === null || events.length === 0}
                onChange={() => setMode('existing')}
              />
              Existující akce
            </label>
            <select
              id={ids.existing}
              aria-label="Existující akce"
              value={existing}
              disabled={mode !== 'existing'}
              onChange={(e) => setExisting(e.target.value)}
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
              <input type="radio" name={ids.mode} checked={mode === 'new'} onChange={() => setMode('new')} />
              Nová akce
            </label>
            <input
              id={ids.name}
              type="text"
              aria-label="Název nové akce"
              value={newName}
              disabled={mode !== 'new'}
              onChange={(e) => setNewName(e.target.value)}
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
          <button type="submit" className="primary big" disabled={!canStart}>
            {busy ? 'Spouštím…' : 'Start'}
          </button>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            Zrušit
          </button>
        </div>
      </form>
    </section>
  )
}
