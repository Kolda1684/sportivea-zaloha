import { baseName, formatBytes, formatCount, formatDuration, plural } from '../format'
import type { EntryOutcome, RunDone, RunStatus } from '../../../shared/download-ipc'
import {
  ABORTED_TEXT,
  AUTH_LOST_TEXT,
  CHOOSE_OTHER_PLACE,
  CONTINUE,
  DESTINATION_LOST_TEXT,
  DISK_FULL_TEXT,
  DONE_OK_HEADING,
  DOWNLOAD_ANOTHER,
  JOURNAL_ERROR_TEXT,
  MANIFEST_FAILED_TEXT,
  NOT_FINISHED_HEADING,
  RETRY_FAILED,
  SHOW_IN_FINDER,
  SIGN_IN_AND_CONTINUE,
} from '../strings'

/** Each list (failed, skipped) is cut here; the full list is in the CSV. */
const MAX_LISTED = 20

export type DoneProps = {
  done: RunDone
  /** A retry/continue is being started. */
  busy: boolean
  /** Why the last retry/continue could not start. */
  error: string | null
  /** The sign-in is gone (after `auth_lost`): Pokračovat signs in first. */
  needsSignIn: boolean
  onRetry(): void
  onContinue(): void
  onShow(): void
  onNext(): void
  onChooseOther(): void
}

const COUNT_LABELS: [EntryOutcome, string][] = [
  ['downloaded', 'Staženo a ověřeno'],
  ['exported', 'Exportováno z Google Dokumentů'],
  ['already', 'Už stažené dřív'],
  ['changed_copy', 'Změněné na Disku (uloženo jako kopie)'],
  ['duplicate', 'Duplikáty (stejný obsah už je na disku)'],
  ['skipped', 'Přeskočeno'],
  ['failed', 'Selhalo'],
]

function failedCount(done: RunDone): number {
  return Math.max(done.counts.failed, done.failed.length)
}

/** Green needs `complete` AND no failed file, whatever else main reports. */
function effectiveStatus(done: RunDone): RunStatus {
  return done.status === 'complete' && failedCount(done) > 0 ? 'incomplete' : done.status
}

function statusText(done: RunDone, status: RunStatus): string {
  switch (status) {
    case 'complete':
      return ''
    case 'incomplete': {
      const n = failedCount(done)
      if (n === 0) return 'Stahování NENÍ kompletní.'
      return `Stahování NENÍ kompletní: ${formatCount(n)} ${plural(n, 'soubor selhal', 'soubory selhaly', 'souborů selhalo')}.`
    }
    case 'destination_lost':
      return DESTINATION_LOST_TEXT
    case 'auth_lost':
      return AUTH_LOST_TEXT
    case 'aborted':
      return ABORTED_TEXT
    case 'journal_error':
      return JOURNAL_ERROR_TEXT
    case 'disk_full':
      return DISK_FULL_TEXT
  }
}

/** Runs that stopped before the end and continue with "Pokračovat". */
const CONTINUABLE: ReadonlySet<RunStatus> = new Set(['destination_lost', 'auth_lost', 'aborted', 'disk_full'])

type Item = { path: string; reason: string }

/** Up to `MAX_LISTED` items with their reasons, then how many more and where the full list is. */
function ItemList({ items, manifestPath }: { items: Item[]; manifestPath: string | null }) {
  const shown = items.slice(0, MAX_LISTED)
  const hidden = items.length - shown.length
  return (
    <>
      <ul className="plain items">
        {shown.map((f, i) => (
          <li key={i}>
            <span className="strong">{f.path}</span>
            <span className="muted small">{f.reason}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="muted small">
          {manifestPath === null
            ? `…a dalších ${formatCount(hidden)}.`
            : `…a dalších ${formatCount(hidden)} — celý seznam je v souboru ${baseName(manifestPath)}`}
        </p>
      )}
    </>
  )
}

function duration(done: RunDone): string | null {
  const ms = new Date(done.finishedAt).getTime() - new Date(done.startedAt).getTime()
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms / 1000) : null
}

export function Done({ done, busy, error, needsSignIn, onRetry, onContinue, onShow, onNext, onChooseOther }: DoneProps) {
  const status = effectiveStatus(done)
  const ok = status === 'complete'
  const took = duration(done)

  return (
    <section className="stack">
      {ok ? (
        <div className="banner ok" role="status">
          <h1>{DONE_OK_HEADING}</h1>
        </div>
      ) : (
        <div className="banner bad" role="alert">
          <h1>{NOT_FINISHED_HEADING}</h1>
          <p className="banner-text">{statusText(done, status)}</p>
        </div>
      )}

      <div className="card">
        <h2>Výsledek</h2>
        <table className="counts">
          <tbody>
            {COUNT_LABELS.map(([outcome, label]) => (
              <tr key={outcome}>
                <th scope="row">{label}</th>
                <td>{formatCount(done.counts[outcome])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Nově staženo: {formatBytes(done.downloadedBytes)}
          {took !== null && ` za ${took}`}
        </p>
      </div>

      {done.failed.length > 0 && (
        <div className="card danger">
          <h2>Soubory, které se nepodařilo stáhnout</h2>
          <ItemList items={done.failed} manifestPath={done.manifestPath} />
        </div>
      )}

      {done.skipped.length > 0 && (
        <div className="card">
          <h2>Přeskočené položky</h2>
          <ItemList items={done.skipped} manifestPath={done.manifestPath} />
        </div>
      )}

      {done.manifestPath === null ? (
        <p className="callout warn" role="status">
          {MANIFEST_FAILED_TEXT}
        </p>
      ) : (
        <p className="muted small">
          Seznam souborů: <span className="strong">{baseName(done.manifestPath)}</span> (je v cílové složce)
        </p>
      )}

      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        {status === 'incomplete' && (
          <button type="button" className="primary" disabled={busy} onClick={onRetry}>
            {RETRY_FAILED}
          </button>
        )}
        {CONTINUABLE.has(status) && (
          <button type="button" className="primary" disabled={busy} onClick={onContinue}>
            {needsSignIn ? SIGN_IN_AND_CONTINUE : CONTINUE}
          </button>
        )}
        {status === 'journal_error' && (
          <button type="button" className="primary" disabled={busy} onClick={onChooseOther}>
            {CHOOSE_OTHER_PLACE}
          </button>
        )}
        {status !== 'destination_lost' && (
          <button type="button" className="secondary" onClick={onShow}>
            {SHOW_IN_FINDER}
          </button>
        )}
        <button type="button" className={ok ? 'primary' : 'secondary'} disabled={busy} onClick={onNext}>
          {DOWNLOAD_ANOTHER}
        </button>
      </div>
    </section>
  )
}
