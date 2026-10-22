import type { CopyOutcome } from '../core/copy'
import type { RunSummary } from '../core/pipeline'
import type { RunUiEvent } from '../shared/ipc-types'

export type RunPhase = 'starting' | 'queued' | 'running' | 'finished' | 'failed'
export type ItemState = 'sorted' | 'copied' | 'duplicate' | 'verify_failed'

export type RunItem = {
  relPath: string
  marker: boolean
  top: boolean
  /** Category chosen by the classifier; null for files that were never classified (other files, clips confirmed by the journal). */
  category: string | null
  description: string
  classifyOk: boolean
  lowConfidence: boolean
  state: ItemState
  /** File name and folder (relative to the event folder) where the file ended up. */
  destName: string | null
  destFolder: string | null
}

export type RunState = {
  id: string
  cardRoot: string
  eventName: string
  eventDir: string
  templateName: string
  startedAt: number
  phase: RunPhase
  queuePosition: number
  scanned: { videos: number; others: number; bytes: number } | null
  items: RunItem[]
  waitingSpace: boolean
  cardRemoved: boolean
  summary: RunSummary | null
  failure: string | null
}

export type NewRunInput = {
  cardRoot: string
  eventName: string
  eventDir: string
  templateName: string
  startedAt: number
}

export function newRun(input: NewRunInput): RunState {
  return {
    id: `${input.cardRoot}#${input.startedAt}`,
    ...input,
    phase: 'starting',
    queuePosition: 0,
    scanned: null,
    items: [],
    waitingSpace: false,
    cardRemoved: false,
    summary: null,
    failure: null,
  }
}

function blankItem(relPath: string): RunItem {
  return {
    relPath,
    marker: false,
    top: false,
    category: null,
    description: '',
    classifyOk: true,
    lowConfidence: false,
    state: 'sorted',
    destName: null,
    destFolder: null,
  }
}

function upsert(items: RunItem[], relPath: string, change: (item: RunItem) => RunItem): RunItem[] {
  const i = items.findIndex((it) => it.relPath === relPath)
  if (i === -1) return [...items, change(blankItem(relPath))]
  const next = items.slice()
  const current = items[i]
  if (current) next[i] = change(current)
  return next
}

/** Folder of `destPath` relative to the event folder (falls back to the last folder name). */
function folderOf(destPath: string, eventDir: string): string {
  const dir = destPath.slice(0, Math.max(0, destPath.lastIndexOf('/')))
  const prefix = eventDir.endsWith('/') ? eventDir : `${eventDir}/`
  if (dir.startsWith(prefix)) return dir.slice(prefix.length)
  if (dir === eventDir) return ''
  return dir.slice(dir.lastIndexOf('/') + 1)
}

function nameOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

function applyCopy(item: RunItem, outcome: CopyOutcome, eventDir: string): RunItem {
  switch (outcome.status) {
    case 'copied':
      return { ...item, state: 'copied', destName: nameOf(outcome.destPath), destFolder: folderOf(outcome.destPath, eventDir) }
    case 'duplicate':
      return { ...item, state: 'duplicate', destName: nameOf(outcome.destPath), destFolder: folderOf(outcome.destPath, eventDir) }
    case 'verify_failed':
      return { ...item, state: 'verify_failed' }
  }
}

export function reduceRun(run: RunState, event: RunUiEvent): RunState {
  switch (event.type) {
    case 'queued':
      return run.phase === 'starting' ? { ...run, phase: 'queued', queuePosition: event.position } : run
    case 'started':
      return run.phase === 'starting' || run.phase === 'queued' ? { ...run, phase: 'running' } : run
    case 'scanned':
      return { ...run, scanned: { videos: event.videos, others: event.others, bytes: event.bytes } }
    case 'classified':
      return {
        ...run,
        items: upsert(run.items, event.relPath, (item) => ({
          ...item,
          marker: event.marker,
          top: event.top,
          category: event.result.category,
          description: event.result.description,
          classifyOk: event.result.ok,
          lowConfidence: event.result.ok && event.result.confidence === 'low',
        })),
      }
    case 'copied':
      return {
        ...run,
        waitingSpace: false,
        items: upsert(run.items, event.relPath, (item) => applyCopy(item, event.outcome, run.eventDir)),
      }
    case 'waiting_space':
      return { ...run, waitingSpace: true }
    case 'card_removed':
      return { ...run, cardRemoved: true }
    case 'done':
      return { ...run, phase: 'finished', summary: event.summary, waitingSpace: false }
    case 'failed':
      return { ...run, phase: 'failed', failure: event.message, waitingSpace: false }
  }
}

export type Progress = { sortedDone: number; sortedTotal: number; copyDone: number; copyTotal: number }

/**
 * Sorting counts every file the pipeline has dealt with (classified events, marker clips included, plus files that
 * only ever appear as copied: other files and clips confirmed by the journal). Black markers are never copied.
 */
export function progressOf(run: RunState): Progress {
  const sortedTotal = run.scanned ? run.scanned.videos + run.scanned.others : run.items.length
  const markers = run.items.filter((i) => i.marker).length
  const copyDone = run.items.filter((i) => i.state !== 'sorted').length
  return {
    sortedDone: run.items.length,
    sortedTotal: Math.max(sortedTotal, run.items.length),
    copyDone,
    copyTotal: Math.max(sortedTotal - markers, copyDone),
  }
}

export function isActive(run: RunState): boolean {
  return run.phase === 'starting' || run.phase === 'queued' || run.phase === 'running'
}
