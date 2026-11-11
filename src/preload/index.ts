import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppApi } from '../shared/api'
import {
  IPC as CARDS_IPC,
  type CardDetected,
  type CardsApi,
  type Result,
  type RunEventPayload as CardsRunEventPayload,
  type RunStartRequest,
  type Settings,
  type SettingsResult,
} from '../shared/cards-ipc'
import { IPC as DOWNLOAD_IPC, type DownloadApi, type MainEvents } from '../shared/download-ipc'

/** Subscribes to one main → renderer event; the renderer gets only the payload, never the IPC event object. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const download: DownloadApi = {
  ping: () => ipcRenderer.invoke(DOWNLOAD_IPC.ping),
  authStatus: () => ipcRenderer.invoke(DOWNLOAD_IPC.authStatus),
  signIn: () => ipcRenderer.invoke(DOWNLOAD_IPC.authSignIn),
  signOut: () => ipcRenderer.invoke(DOWNLOAD_IPC.authSignOut),
  scan: (link) => ipcRenderer.invoke(DOWNLOAD_IPC.driveScan, link),
  pickDestination: (scanId) => ipcRenderer.invoke(DOWNLOAD_IPC.destPick, scanId),
  startRun: (scanId) => ipcRenderer.invoke(DOWNLOAD_IPC.runStart, scanId),
  abortRun: () => ipcRenderer.invoke(DOWNLOAD_IPC.runAbort),
  retryFailed: () => ipcRenderer.invoke(DOWNLOAD_IPC.runRetryFailed),
  runStatus: () => ipcRenderer.invoke(DOWNLOAD_IPC.runStatus),
  showDestination: () => ipcRenderer.invoke(DOWNLOAD_IPC.shellShowDest),
  onScanProgress: (listener) => subscribe<MainEvents[typeof DOWNLOAD_IPC.driveScanProgress]>(DOWNLOAD_IPC.driveScanProgress, listener),
  onRunEvent: (listener) => subscribe<MainEvents[typeof DOWNLOAD_IPC.runEvent]>(DOWNLOAD_IPC.runEvent, listener),
  onRunDone: (listener) => subscribe<MainEvents[typeof DOWNLOAD_IPC.runDone]>(DOWNLOAD_IPC.runDone, listener),
}

const cards: CardsApi = {
  onCardDetected: (listener) => subscribe<CardDetected>(CARDS_IPC.cardDetected, listener),
  onRunEvent: (listener) => subscribe<CardsRunEventPayload>(CARDS_IPC.runEvent, listener),
  pickCardFolder: () => ipcRenderer.invoke(CARDS_IPC.pickFolder, 'card') as Promise<CardDetected | null>,
  pickRootFolder: () => ipcRenderer.invoke(CARDS_IPC.pickFolder, 'root') as Promise<string | null>,
  listEvents: () => ipcRenderer.invoke(CARDS_IPC.eventsList) as Promise<string[]>,
  startRun: (request: RunStartRequest) => ipcRenderer.invoke(CARDS_IPC.runStart, request) as Promise<Result>,
  getSettings: () => ipcRenderer.invoke(CARDS_IPC.settingsGet) as Promise<Settings>,
  setSettings: (patch) => ipcRenderer.invoke(CARDS_IPC.settingsSet, patch) as Promise<SettingsResult>,
  setApiKey: (key) => ipcRenderer.invoke(CARDS_IPC.apiKeySet, key) as Promise<Result>,
  hasApiKey: () => ipcRenderer.invoke(CARDS_IPC.apiKeyHas) as Promise<boolean>,
  openFolder: (path) => ipcRenderer.invoke(CARDS_IPC.openFolder, path) as Promise<string>,
  toolsOk: () => ipcRenderer.invoke(CARDS_IPC.toolsOk) as Promise<boolean>,
}

// Only these typed functions are exposed; the renderer never gets ipcRenderer itself.
const api: AppApi = { download, cards }

contextBridge.exposeInMainWorld('api', api)
