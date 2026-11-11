import { useState } from 'react'
import type { RunEventPayload, RunStatusInfo } from '../../../shared/download-ipc'
import { eta, formatBytes, formatCount, formatDuration, formatSpeed } from '../format'
import { NOT_FINISHED_HEADING, STOPPING, STOP_BUTTON, STOP_CONFIRM_NO, STOP_CONFIRM_TEXT, STOP_CONFIRM_YES } from '../strings'

/** Speed is measured over this window; a longer one hides a stall, a shorter one jumps around. */
const SPEED_WINDOW_MS = 15_000
/** Below this span between the oldest and newest sample there is no reliable speed yet. */
const MIN_SPEED_SPAN_MS = 1000
/** Without a `bytes` event for this long the speed and ETA are no longer shown. */
export const STALL_MS = 10_000

type Sample = { at: number; bytes: number }

export type ProgressState = {
  doneBytes: number
  totalBytes: number
  /** Files and exports finished so far (skipped items are not files). */
  filesDone: number
  filesTotal: number
  currentPath: string | null
  /** Bytes per second over the last seconds; `null` until it can be measured (or while stalled). */
  speed: number | null
  etaSeconds: number | null
  /** No `bytes` event for `STALL_MS`: speed and ETA are shown as a dash. */
  stalled: boolean
  /** Arrival time of the last `bytes` event. */
  lastBytesAt: number | null
  /** Planned bytes of files that were already on disk or failed: they move `doneBytes` without any transfer. */
  untransferred: number
  samples: Sample[]
  /** The file in progress: `doneBytes` when it started, its planned size, and how far its last two byte events were. */
  fileStartDone: number
  fileSize: number | null
  filePrev: number
  fileLast: number
  fileEvents: number
}

export function initialProgress(filesTotal: number, totalBytes = 0): ProgressState {
  return {
    doneBytes: 0,
    totalBytes,
    filesDone: 0,
    filesTotal,
    currentPath: null,
    speed: null,
    etaSeconds: null,
    stalled: false,
    lastBytesAt: null,
    untransferred: 0,
    samples: [],
    fileStartDone: 0,
    fileSize: null,
    filePrev: 0,
    fileLast: 0,
    fileEvents: 0,
  }
}

/** Progress of a run already in progress (a window that loaded mid-run); speed and ETA follow from the next events. */
export function progressFromStatus(status: Extract<RunStatusInfo, { running: true }>): ProgressState {
  const { doneBytes } = status
  return {
    ...initialProgress(status.filesTotal, status.totalBytes),
    doneBytes,
    filesDone: status.filesDone,
    currentPath: status.currentPath,
    fileStartDone: doneBytes,
    filePrev: doneBytes,
    fileLast: doneBytes,
  }
}

function measure(samples: Sample[], previous: number | null): number | null {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined || last.at - first.at < MIN_SPEED_SPAN_MS) return previous
  return Math.max(0, last.bytes - first.bytes) / ((last.at - first.at) / 1000)
}

/**
 * Folds one downloader event into the progress; `at` is the arrival time in ms.
 *
 * The downloader emits the final `bytes` event of a file (planned size added) BEFORE `file_done`. For a file that
 * was already on disk, or that failed, that jump is not a transfer. While the jump looks like a finished file the
 * speed is therefore held, and `file_done` removes the bytes that were not received from the last sample.
 */
export function reduceProgress(state: ProgressState, event: RunEventPayload, at: number): ProgressState {
  switch (event.type) {
    case 'file_start':
      return {
        ...state,
        currentPath: event.entry.drivePath,
        fileStartDone: state.doneBytes,
        fileSize: event.entry.kind === 'file' ? (event.entry.size ?? 0) : null,
        filePrev: state.doneBytes,
        fileLast: state.doneBytes,
        fileEvents: 0,
      }
    case 'file_done': {
      const { outcome, entry } = event.result
      let { untransferred } = state
      let samples = state.samples
      if ((outcome === 'already' || outcome === 'failed') && entry.kind === 'file') {
        const received = Math.max(0, state.filePrev - state.fileStartDone)
        const delta = Math.max(0, (entry.size ?? 0) - received)
        untransferred += delta
        const last = samples[samples.length - 1]
        if (state.fileEvents > 0 && last !== undefined && delta > 0) {
          const before = samples[samples.length - 2]?.bytes ?? 0
          samples = [...samples.slice(0, -1), { at: last.at, bytes: Math.max(before, last.bytes - delta) }]
        }
      }
      const speed = measure(samples, state.speed)
      return {
        ...state,
        filesDone: outcome === 'skipped' || outcome === 'duplicate' ? state.filesDone : state.filesDone + 1,
        untransferred,
        samples,
        speed,
        etaSeconds: speed === null ? null : eta(state.doneBytes, state.totalBytes, speed),
        fileSize: null,
      }
    }
    case 'bytes': {
      const transferred = Math.max(0, event.doneBytes - state.untransferred)
      const samples = [...state.samples, { at, bytes: transferred }]
      while (samples.length > 2 && (samples[1]?.at ?? Number.POSITIVE_INFINITY) <= at - SPEED_WINDOW_MS) samples.shift()
      const looksFinished = state.fileSize !== null && event.doneBytes - state.fileStartDone >= state.fileSize
      const speed = looksFinished ? state.speed : measure(samples, state.speed)
      return {
        ...state,
        doneBytes: event.doneBytes,
        totalBytes: event.totalBytes,
        samples,
        speed,
        etaSeconds: speed === null ? null : eta(event.doneBytes, event.totalBytes, speed),
        stalled: false,
        lastBytesAt: at,
        filePrev: state.fileLast,
        fileLast: event.doneBytes,
        fileEvents: state.fileEvents + 1,
      }
    }
  }
}

/** Called every second: drops speed and ETA when no `bytes` event arrived for `STALL_MS`. Returns the same object when nothing changes. */
export function staleProgress(state: ProgressState, now: number): ProgressState {
  if (state.stalled || state.lastBytesAt === null || now - state.lastBytesAt <= STALL_MS) return state
  return { ...state, speed: null, etaSeconds: null, samples: [], stalled: true }
}

/** Before the first measurement "zjišťuji…"; after a stall a dash (the old number would be a lie). */
const unknown = (p: ProgressState): string => (p.stalled ? '—' : 'zjišťuji…')

const percentOf = (done: number, total: number): number => (total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0)

function Bar({ label, text, percent }: { label: string; text: string; percent: number }) {
  return (
    <div className="bar">
      <div className="bar-head">
        <span className="strong">{label}</span>
        <span className="muted">
          {text} · {percent} %
        </span>
      </div>
      <div className="track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

type StopConfirmProps = { onConfirm(): void; onCancel(): void }

export function StopConfirm({ onConfirm, onCancel }: StopConfirmProps) {
  return (
    <div className="card danger stack tight" role="alertdialog" aria-label={STOP_BUTTON}>
      <p>{STOP_CONFIRM_TEXT}</p>
      <div className="actions">
        <button type="button" className="primary" autoFocus onClick={onCancel}>
          {STOP_CONFIRM_NO}
        </button>
        <button type="button" className="secondary danger-text" onClick={onConfirm}>
          {STOP_CONFIRM_YES}
        </button>
      </div>
    </div>
  )
}

type ProgressProps = { progress: ProgressState; onAbort(): void }

export function Progress({ progress, onAbort }: ProgressProps) {
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const bytesPercent = percentOf(progress.doneBytes, progress.totalBytes)
  const filesPercent = percentOf(progress.filesDone, progress.filesTotal)

  return (
    <section className="stack">
      <div className="not-finished" role="status">
        {NOT_FINISHED_HEADING}
      </div>

      <div className="card stack tight">
        <Bar label="Objem" text={`${formatBytes(progress.doneBytes)} z ${formatBytes(progress.totalBytes)}`} percent={bytesPercent} />
        <Bar label="Soubory" text={`${formatCount(progress.filesDone)} z ${formatCount(progress.filesTotal)}`} percent={filesPercent} />
      </div>

      <div className="card stack tight">
        <p className="muted small">Právě stahuji</p>
        <p className="path">{progress.currentPath ?? '…'}</p>
        <p>
          <span className="strong">Rychlost:</span> {progress.speed === null ? unknown(progress) : formatSpeed(progress.speed)}
          {' · '}
          <span className="strong">Zbývá:</span> {progress.etaSeconds === null ? unknown(progress) : formatDuration(progress.etaSeconds)}
        </p>
      </div>

      {confirming ? (
        <StopConfirm
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            setStopping(true)
            onAbort()
          }}
        />
      ) : (
        <div className="actions">
          <button type="button" className="secondary" disabled={stopping} onClick={() => setConfirming(true)}>
            {stopping ? STOPPING : STOP_BUTTON}
          </button>
        </div>
      )}
    </section>
  )
}
