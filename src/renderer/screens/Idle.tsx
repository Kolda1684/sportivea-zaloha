import { useState } from 'react'
import type { Settings } from '../../shared/ipc-types'
import type { Pending } from '../App'
import { formatBytes, plural } from '../format'
import type { RecentRun, RecentStatus } from '../recent'
import { progressOf, type RunState } from '../runState'

type Props = {
  settings: Settings
  pending: Pending[]
  activeRuns: RunState[]
  finishedRuns: RunState[]
  recent: RecentRun[]
  onPick(): Promise<boolean>
  onOpenRun(id: string): void
  onOpenPending(): void
  onOpenSettings(): void
}

const STATUS_LABEL: Record<RecentStatus, string> = {
  ok: 'Zálohováno a ověřeno',
  card_removed: 'Karta byla odpojena, nezálohováno celé',
  verify_failed: 'Něco se nepodařilo ověřit',
  aborted: 'Přerušeno, nezálohováno celé',
  failed: 'Selhalo',
}

function formatWhen(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()} ${d.getHours()}:${p(d.getMinutes())}`
}

export function Idle({ settings, pending, activeRuns, finishedRuns, recent, onPick, onOpenRun, onOpenPending, onOpenSettings }: Props) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = async (): Promise<void> => {
    setBusy(true)
    setNote('')
    try {
      const ok = await onPick()
      if (!ok) setNote('Nic nebylo vybráno, nebo se z té složky nepodařilo načíst kartu.')
    } finally {
      setBusy(false)
    }
  }

  const shownRecent = recent.filter((r) => !finishedRuns.some((f) => f.id === r.id))

  return (
    <section className="stack idle">
      <div className="hero">
        <h1>Zasuň kartu</h1>
        <p className="lead">Aplikace kartu pozná sama a nabídne roztřídění. Nic na kartě se nemění ani nemaže.</p>
        <button type="button" className="secondary" onClick={() => void pick()} disabled={busy}>
          Vybrat složku ručně
        </button>
        {note && <p className="muted small">{note}</p>}
      </div>

      {settings.rootDir === null && (
        <div className="callout warn">
          <p>Nejdřív vyber složku na Google Disku, do které se budou ukládat akce.</p>
          <button type="button" onClick={onOpenSettings}>
            Otevřít nastavení
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="card">
          <h2>Čeká {pending.length === 1 ? 'karta' : 'karty'} na nastavení</h2>
          <ul className="plain">
            {pending.map((p) => (
              <li key={p.card.root}>
                <span className="strong">{p.card.volumeName}</span>
                <span className="muted">
                  {' '}
                  · {p.card.videos} {plural(p.card.videos, 'klip', 'klipy', 'klipů')} · {formatBytes(p.card.bytes)}
                </span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onOpenPending}>
            Nastavit zálohu
          </button>
        </div>
      )}

      {activeRuns.length > 0 && (
        <div className="card">
          <h2>Právě běží</h2>
          <ul className="plain rows">
            {activeRuns.map((r) => {
              const p = progressOf(r)
              return (
                <li key={r.id}>
                  <button type="button" className="rowbtn" onClick={() => onOpenRun(r.id)}>
                    <span className="strong">{r.eventName}</span>
                    <span className="muted">
                      {r.phase === 'queued' || r.phase === 'starting' ? 'čeká na řadu' : `nahráno ${p.copyDone} z ${p.copyTotal}`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="not-backed">Karta ještě NENÍ zálohovaná</p>
        </div>
      )}

      {finishedRuns.length > 0 && (
        <div className="card">
          <h2>Dokončeno — čeká na potvrzení</h2>
          <ul className="plain rows">
            {finishedRuns.map((r) => (
              <li key={r.id}>
                <button type="button" className="rowbtn" onClick={() => onOpenRun(r.id)}>
                  <span className="strong">{r.eventName}</span>
                  <span className="muted">{r.summary ? STATUS_LABEL[r.summary.status] : STATUS_LABEL.failed}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Poslední běhy</h2>
        {shownRecent.length === 0 ? (
          <p className="muted">Zatím žádné.</p>
        ) : (
          <ul className="plain rows">
            {shownRecent.map((r) => (
              <li key={r.id} className="recent">
                <span className="strong">{r.eventName}</span>
                <span className={r.status === 'ok' ? 'tag ok' : 'tag bad'}>{STATUS_LABEL[r.status]}</span>
                <span className="muted small">{formatWhen(r.finishedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
