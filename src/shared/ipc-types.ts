import type { RunEvent } from '../core/pipeline'
import type { Template } from '../core/templates'

export type Model = 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-haiku-5-5'

export type Settings = {
  /** Google Drive folder that holds the event folders; null until the user picks it. */
  rootDir: string | null
  model: Model
  templates: Template[]
  lastTemplateId: string
  /** Saved roster text by team name. */
  rosters: Record<string, string>
  lumaThreshold: number
  czkPerUsd: number
}

/** IPC channel names. Shared by main and preload so that they cannot drift apart. */
export const IPC = {
  cardDetected: 'card:detected',
  pickFolder: 'card:pickFolder',
  eventsList: 'events:list',
  runStart: 'run:start',
  runEvent: 'run:event',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  apiKeySet: 'apikey:set',
  apiKeyHas: 'apikey:has',
  openFolder: 'shell:openFolder',
} as const

/** Argument of `card:pickFolder`: which folder the dialog is for. */
export type PickPurpose = 'card' | 'root'

/** main -> renderer: a card was found (or picked by hand). Dates are ISO strings from file times. */
export type CardDetected = {
  root: string
  volumeName: string
  videos: number
  bytes: number
  firstDate: string | null
  lastDate: string | null
}

export type RunStartRequest = {
  cardRoot: string
  eventName: string
  /** true: create the event folder (refuse if it exists); false: add to an existing event folder. */
  isNew: boolean
  templateId: string
  rosterText: string
}

/** `error` is a Czech sentence meant to be shown to the user. */
export type Result = { ok: true } | { ok: false; error: string }
export type SettingsResult = { ok: true; settings: Settings } | { ok: false; error: string }

/** What the renderer receives on `run:event`: pipeline events plus queue/failure notices. */
export type RunUiEvent =
  | RunEvent
  | { type: 'queued'; position: number }
  | { type: 'started' }
  | { type: 'failed'; message: string }

export type RunEventPayload = { cardRoot: string; event: RunUiEvent }

/** `window.api`, exposed by the preload script through `contextBridge`. */
export type Api = {
  onCardDetected(listener: (card: CardDetected) => void): () => void
  onRunEvent(listener: (payload: RunEventPayload) => void): () => void
  /** Folder picker for a card without a recognisable structure (or for testing). null when cancelled or unreadable. */
  pickCardFolder(): Promise<CardDetected | null>
  /** Folder picker for the root folder on Google Drive. Resolves to the chosen path (not saved yet), or null when cancelled. */
  pickRootFolder(): Promise<string | null>
  listEvents(): Promise<string[]>
  startRun(request: RunStartRequest): Promise<Result>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<SettingsResult>
  setApiKey(key: string): Promise<Result>
  hasApiKey(): Promise<boolean>
  /** Opens a folder inside the root folder in Finder. Resolves to an error text, or '' on success. */
  openFolder(path: string): Promise<string>
}
