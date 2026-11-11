import { useState } from 'react'
import type { RunSummary } from '../../../core/cards/pipeline'
import { UNCLASSIFIED } from '../../../core/cards/templates'
import { api } from '../api'
import { baseName, classifyFailureMessage, formatCzk, plural } from '../format'
import { countClassifyFailures, type RunItem, type RunState } from '../runState'
import {
  ABORTED_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  CARD_REMOVED_MESSAGE,
  FINAL_OK_MESSAGE,
  NO_AI_DONE_MESSAGE,
  NOT_BACKED_UP_HEADING,
  VERIFY_FAILED_MESSAGE,
} from '../strings'

type ManualEntry = { key: string; name: string; folder: string; original: string; reason: string }

/** Low-confidence clips (from the summary) plus every clip that ended up unclassified (all of them after a backup without sorting, so none are listed then). */
function manualChecks(summary: RunSummary, items: RunItem[]): ManualEntry[] {
  if (summary.ai === 'off') return []
  const byPath = new Map(items.map((i) => [i.relPath, i]))
  const entries = new Map<string, ManualEntry>()
  const entry = (relPath: string, reason: string): ManualEntry => {
    const item = byPath.get(relPath)
    return {
      key: relPath,
      name: item?.destName ?? baseName(relPath),
      folder: item?.destFolder ?? item?.category ?? '',
      original: relPath,
      reason,
    }
  }
  for (const relPath of summary.lowConfidence) entries.set(relPath, entry(relPath, 'nejisté zařazení — zkontroluj, jestli je ve správné složce'))
  for (const item of items) {
    if (item.marker || item.destFolder !== UNCLASSIFIED || entries.has(item.relPath)) continue
    entries.set(
      item.relPath,
      entry(
        item.relPath,
        item.category === null
          ? 'nezařazeno — nahráno už při dřívějším běhu'
          : item.classifyOk
            ? 'nezařazeno — nebylo jasné, kam klip patří'
            : 'nezařazeno — klip se nepodařilo roztřídit, zůstal pod původním názvem',
      ),
    )
  }
  return [...entries.values()].sort((a, b) => a.original.localeCompare(b.original, 'cs'))
}

function OpenFolder({ path, label }: { path: string; label: string }) {
  const [error, setError] = useState('')
  return (
    <>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setError('')
          void api().openFolder(path).then(setError, (e: unknown) => setError(e instanceof Error ? e.message : 'Složku nejde otevřít.'))
        }}
      >
        {label}
      </button>
      {error && <span className="field-error">{error}</span>}
    </>
  )
}

type DoneProps = {
  run: RunState
  summary: RunSummary
  czkPerUsd: number
  canRerun: boolean
  onRerun(): void
  onClose(): void
}

export function Done({ run, summary, czkPerUsd, canRerun, onRerun, onClose }: DoneProps) {
  const folders = Object.entries(summary.perFolder).sort(([a], [b]) => a.localeCompare(b, 'cs'))
  const copiedClips = folders.reduce((sum, [, n]) => sum + n, 0)
  const manual = manualChecks(summary, run.items)
  const ok = summary.status === 'ok'
  // after a backup without sorting, no clip "failed": none was meant to be sorted
  const failedClassify = summary.ai === 'off' ? 0 : countClassifyFailures(run)

  return (
    <section className="stack">
      {ok ? (
        <div className="banner ok" role="status">
          <h1>Hotovo</h1>
          <p className="banner-text">{FINAL_OK_MESSAGE}</p>
        </div>
      ) : (
        <div className="banner bad" role="alert">
          <h1>{NOT_BACKED_UP_HEADING}</h1>
          {summary.status === 'aborted' && <p className="banner-text">{ABORTED_MESSAGE}</p>}
          {summary.status === 'card_removed' && <p className="banner-text">{CARD_REMOVED_MESSAGE}</p>}
          {summary.status === 'verify_failed' && <p className="banner-text">{VERIFY_FAILED_MESSAGE}</p>}
        </div>
      )}

      {summary.ai === 'off' && (
        <p className="callout warn" role="status">
          {NO_AI_DONE_MESSAGE}
        </p>
      )}

      {summary.ai === 'unavailable' && (
        <p className="callout warn" role="status">
          {AI_UNAVAILABLE_MESSAGE}
        </p>
      )}

      {failedClassify > 0 && (
        <p className="callout warn" role="status">
          {classifyFailureMessage(failedClassify)}
          {ok ? '. Záloha samotná je v pořádku.' : '.'}
        </p>
      )}

      {summary.verifyFailed.length > 0 && (
        <div className="card danger">
          <h2>{summary.status === 'verify_failed' ? 'Soubory bez ověření' : 'Tyto soubory se nepodařilo ověřit'}</h2>
          <ul className="plain mono">
            {summary.verifyFailed.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Akce „{run.eventName}“</h2>
        {folders.length === 0 ? (
          <p className="muted">Nic se nenahrálo.</p>
        ) : (
          <table className="counts">
            <tbody>
              {folders.map(([folder, n]) => (
                <tr key={folder}>
                  <th scope="row">{folder}</th>
                  <td>
                    {n} {plural(n, 'klip', 'klipy', 'klipů')}
                  </td>
                </tr>
              ))}
              <tr className="sum">
                <th scope="row">Celkem klipů</th>
                <td>{copiedClips}</td>
              </tr>
            </tbody>
          </table>
        )}
        <ul className="plain facts">
          <li>
            <span className="strong">TOP záběry:</span> {summary.top}
          </li>
          <li>
            <span className="strong">Černé značky</span> (nekopírují se): {summary.markers}
          </li>
          {summary.orphanMarkers > 0 && (
            <li>
              <span className="strong">Osiřelé značky</span> (bez TOP záběru, v CSV „bez TOP“): {summary.orphanMarkers}
            </li>
          )}
          {summary.others > 0 && (
            <li>
              <span className="strong">Ostatní soubory</span> (složka _ostatni): {summary.others}
            </li>
          )}
          <li>
            <span className="strong">Už nahráno dřív:</span> {summary.alreadyUploaded}
          </li>
          <li>
            <span className="strong">Cena za třídění:</span> {formatCzk(summary.costUsd * czkPerUsd)}
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Zkontroluj ručně</h2>
        {summary.ai === 'off' ? (
          <p className="muted">Záloha proběhla bez třídění — klipy ve složce _nezařazeno roztřiď ručně.</p>
        ) : manual.length === 0 ? (
          <p className="muted">Nic takového — všechno bylo zařazeno s jistotou.</p>
        ) : (
          <ul className="plain manual">
            {manual.map((m) => (
              <li key={m.key}>
                <div>
                  <span className="strong">{m.name}</span>
                  {m.folder !== '' && <span className="muted"> · {m.folder}</span>}
                </div>
                <div className="muted small">
                  {m.reason} (na kartě: {m.original})
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {summary.csvPath !== '' && <p className="muted small">Přehled přejmenování je v souboru {baseName(summary.csvPath)} ve složce akce.</p>}

      <div className="actions">
        <OpenFolder path={run.eventDir} label="Otevřít složku" />
        {!ok && canRerun && (
          <button type="button" className="primary" onClick={onRerun}>
            Spustit znovu
          </button>
        )}
        <button type="button" className={ok ? 'primary' : 'secondary'} onClick={onClose}>
          Zavřít
        </button>
      </div>
    </section>
  )
}

type FailedProps = { run: RunState; canRerun: boolean; onRerun(): void; onClose(): void }

/** The run could not be carried out at all (the queue reported `failed`). */
export function RunFailed({ run, canRerun, onRerun, onClose }: FailedProps) {
  return (
    <section className="stack">
      <div className="banner bad" role="alert">
        <h1>{NOT_BACKED_UP_HEADING}</h1>
        <p className="banner-text">Něco se pokazilo: {run.failure ?? 'neznámá chyba'}</p>
        <p className="banner-text">Nic se nesmazalo. Zkus ji spustit znovu — nahraje se jen to, co chybí.</p>
      </div>
      <div className="actions">
        <OpenFolder path={run.eventDir} label="Otevřít složku" />
        {canRerun && (
          <button type="button" className="primary" onClick={onRerun}>
            Spustit znovu
          </button>
        )}
        <button type="button" className="secondary" onClick={onClose}>
          Zavřít
        </button>
      </div>
    </section>
  )
}
