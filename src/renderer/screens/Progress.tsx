import { baseName, plural } from '../format'
import { progressOf, type ItemState, type RunItem, type RunState } from '../runState'
import { CARD_REMOVED_MESSAGE, NOT_BACKED_UP, WAITING_SPACE_MESSAGE } from '../strings'

type Props = {
  run: RunState
  onBack(): void
}

function Bar({ label, done, total }: { label: string; done: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="bar">
      <div className="bar-head">
        <span className="strong">{label}</span>
        <span className="muted">
          {done} z {total} · {percent} %
        </span>
      </div>
      <div className="track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

const STATE_LABEL: Record<ItemState, string> = {
  sorted: 'roztříděno, čeká na nahrání',
  copied: 'nahráno a ověřeno',
  duplicate: 'už nahráno dříve',
  verify_failed: 'nepodařilo se ověřit',
}

function Row({ item }: { item: RunItem }) {
  const original = baseName(item.relPath)
  const name = item.marker ? original : (item.destName ?? original)
  const folder = item.marker ? 'černá značka — nekopíruje se' : (item.destFolder ?? item.category ?? '')
  const state = item.marker ? 'přeskočeno' : STATE_LABEL[item.state]
  const cls = item.state === 'verify_failed' ? 'bad' : item.state === 'sorted' || item.marker ? 'wait' : 'ok'
  return (
    <li className="item">
      <span className="item-name" title={item.relPath}>
        {name}
        {item.top && <span className="badge top">TOP</span>}
      </span>
      <span className="item-folder">{folder}</span>
      <span className={`item-state ${cls}`}>{state}</span>
    </li>
  )
}

export function Progress({ run, onBack }: Props) {
  const p = progressOf(run)
  const waitingInQueue = run.phase === 'queued' && run.queuePosition > 0
  const items = run.items.slice().reverse()

  let status: string
  if (run.phase === 'starting') status = 'Spouštím…'
  else if (waitingInQueue) status = `Čeká na řadu — před touto kartou ${run.queuePosition === 1 ? 'je' : 'jsou'} ${run.queuePosition} ${plural(run.queuePosition, 'další', 'další', 'dalších')}.`
  else if (run.phase === 'queued') status = 'Spouštím…'
  else if (run.scanned === null) status = 'Prohlížím kartu…'
  else if (run.items.length === 0) status = 'Prohlížím klipy na kartě, za chvíli začne třídění…'
  else status = `Akce „${run.eventName}“`

  return (
    <section className="stack">
      <div className="not-backed big" role="status">
        {NOT_BACKED_UP}
      </div>
      <p className="lead">{status}</p>
      {run.phase === 'running' && run.scanned !== null && <p className="muted small">Šablona {run.templateName} · neodpojuj kartu, dokud se neukáže zelené potvrzení.</p>}

      {run.cardRemoved && (
        <p className="callout bad" role="alert">
          {CARD_REMOVED_MESSAGE}
        </p>
      )}
      {run.waitingSpace && (
        <p className="callout warn" role="status">
          {WAITING_SPACE_MESSAGE}
        </p>
      )}

      <div className="card stack tight">
        <Bar label="Třídění" done={p.sortedDone} total={p.sortedTotal} />
        <Bar label="Nahrávání" done={p.copyDone} total={p.copyTotal} />
      </div>

      <div className="card">
        <h2>Klipy</h2>
        {items.length === 0 ? (
          <p className="muted">Zatím nic. Třídění začíná prohlédnutím všech klipů.</p>
        ) : (
          <ul className="plain items" aria-label="Zpracované klipy">
            {items.map((item) => (
              <Row key={item.relPath} item={item} />
            ))}
          </ul>
        )}
      </div>

      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}>
          Zpět na úvod (běh pokračuje)
        </button>
      </div>
    </section>
  )
}
