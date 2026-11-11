import { useState } from 'react'
import type { PlanSummary, PreflightInfo, ScanProgress } from '../../../shared/download-ipc'
import { formatBytes, formatCount, formatDate, plural } from '../format'
import {
  CHANGE_DESTINATION,
  FOLDER_EXISTS_NEW,
  FOREIGN_TEXT,
  LINK_LABEL,
  LINK_PLACEHOLDER,
  LOAD_FOLDER,
  PICK_DESTINATION,
  RESUME_NO_DATE,
  RESUME_WITH_DATE,
  SCANNING,
  START,
  STARTING,
} from '../strings'

export type ChooseProps = {
  /** Pre-fills the link field (the scanned link when coming back from the result screen). */
  initialLink?: string
  scanning: boolean
  /** Live counts while scanning; progress arrives per folder, so there is no percentage. */
  scanProgress: ScanProgress | null
  scanError: string | null
  plan: PlanSummary | null
  preflight: PreflightInfo | null
  destError: string | null
  startError: string | null
  starting: boolean
  onScan(link: string): void
  onPickDestination(): void
  onStart(): void
}

export const filesText = (n: number): string => `${formatCount(n)} ${plural(n, 'soubor', 'soubory', 'souborů')}`

function stateText(pf: PreflightInfo): string {
  switch (pf.state) {
    case 'new':
      return `${FOLDER_EXISTS_NEW} ${pf.destRoot}`
    case 'resume': {
      const date = formatDate(pf.lastRunAt)
      return date === null ? RESUME_NO_DATE : `${RESUME_WITH_DATE} ${date}.`
    }
    case 'foreign':
      return FOREIGN_TEXT
  }
}

function Scanning({ progress }: { progress: ScanProgress | null }) {
  return (
    <div className="card stack tight" role="status" aria-live="polite" aria-busy="true">
      <p className="strong">
        {SCANNING}
        {progress !== null && ` ${filesText(progress.files)}, ${formatBytes(progress.bytes)}`}
      </p>
      <div className="track indeterminate" aria-hidden="true">
        <div className="fill" />
      </div>
    </div>
  )
}

function Summary({ plan }: { plan: PlanSummary }) {
  return (
    <div className="card summary">
      <h2>{plan.rootName}</h2>
      <dl>
        <div>
          <dt>Souborů</dt>
          <dd>{formatCount(plan.fileCount)}</dd>
        </div>
        <div>
          <dt>Složek</dt>
          <dd>{formatCount(plan.folderCount)}</dd>
        </div>
        <div>
          <dt>Velikost</dt>
          <dd>{formatBytes(plan.totalBytes)}</dd>
        </div>
        <div>
          <dt>Přeskočeno</dt>
          <dd>{formatCount(plan.skipped)}</dd>
        </div>
      </dl>
      {plan.duplicateCount > 0 && (
        <p className="small">
          {`Duplikáty: ${filesText(plan.duplicateCount)} (${formatBytes(plan.duplicateBytes)}) má stejný obsah jako jiný soubor ve složce. Stáhnou se jen jednou, v seznamu souborů je u nich uvedeno, kde je originál.`}
        </p>
      )}
      {plan.skipped > 0 && <p className="muted small">Přeskočené položky (zástupci, formuláře a jiné, co nejde stáhnout) se nestahují, jsou uvedené v seznamu souborů po dokončení.</p>}
    </div>
  )
}

function PreflightCard({ pf }: { pf: PreflightInfo }) {
  return (
    <div className="card stack tight">
      <dl className="facts-row">
        <div>
          <dt>Volné místo na disku</dt>
          <dd>{formatBytes(pf.freeBytes)}</dd>
        </div>
        <div>
          <dt>Potřeba</dt>
          <dd>{formatBytes(pf.neededBytes)}</dd>
        </div>
      </dl>
      <p className={pf.state === 'foreign' ? 'strong' : undefined}>{stateText(pf)}</p>
      {pf.problem !== null && (
        <p className="callout bad" role="alert">
          {pf.problem}
        </p>
      )}
      {pf.warning !== null && (
        <p className="callout warn" role="status">
          {pf.warning}
        </p>
      )}
    </div>
  )
}

export function Choose(props: ChooseProps) {
  const { initialLink, scanning, scanProgress, scanError, plan, preflight, destError, startError, starting, onScan, onPickDestination, onStart } = props
  const [link, setLink] = useState(initialLink ?? '')
  const canStart = plan !== null && preflight !== null && preflight.problem === null && !starting && !scanning

  return (
    <section className="stack">
      <form
        className="card stack tight"
        onSubmit={(e) => {
          e.preventDefault()
          if (link.trim() !== '' && !scanning) onScan(link.trim())
        }}
      >
        <label>
          {LINK_LABEL}
          <input type="text" value={link} placeholder={LINK_PLACEHOLDER} spellCheck={false} autoComplete="off" disabled={scanning} onChange={(e) => setLink(e.target.value)} />
        </label>
        <div className="actions">
          <button type="submit" className="primary" disabled={scanning || link.trim() === ''}>
            {LOAD_FOLDER}
          </button>
        </div>
        {scanError !== null && (
          <p className="field-error" role="alert">
            {scanError}
          </p>
        )}
      </form>

      {scanning && <Scanning progress={scanProgress} />}

      {!scanning && plan !== null && (
        <>
          <Summary plan={plan} />
          <div className="actions">
            <button type="button" className="secondary" disabled={starting} onClick={onPickDestination}>
              {preflight === null ? PICK_DESTINATION : CHANGE_DESTINATION}
            </button>
          </div>
          {destError !== null && (
            <p className="field-error" role="alert">
              {destError}
            </p>
          )}
          {preflight !== null && <PreflightCard pf={preflight} />}
          <div className="actions sticky">
            <button type="button" className="primary big" disabled={!canStart} onClick={onStart}>
              {starting ? STARTING : START}
            </button>
            {startError !== null && (
              <span className="field-error" role="alert">
                {startError}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
