import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type Api,
  type CardDetected,
  type Result,
  type RunEventPayload,
  type RunStartRequest,
  type Settings,
  type SettingsResult,
} from '../shared/ipc-types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

// Only these typed functions are exposed; the renderer never gets ipcRenderer itself.
const api: Api = {
  onCardDetected: (listener) => subscribe<CardDetected>(IPC.cardDetected, listener),
  onRunEvent: (listener) => subscribe<RunEventPayload>(IPC.runEvent, listener),
  pickCardFolder: () => ipcRenderer.invoke(IPC.pickFolder, 'card') as Promise<CardDetected | null>,
  pickRootFolder: () => ipcRenderer.invoke(IPC.pickFolder, 'root') as Promise<string | null>,
  listEvents: () => ipcRenderer.invoke(IPC.eventsList) as Promise<string[]>,
  startRun: (request: RunStartRequest) => ipcRenderer.invoke(IPC.runStart, request) as Promise<Result>,
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch) as Promise<SettingsResult>,
  setApiKey: (key) => ipcRenderer.invoke(IPC.apiKeySet, key) as Promise<Result>,
  hasApiKey: () => ipcRenderer.invoke(IPC.apiKeyHas) as Promise<boolean>,
  openFolder: (path) => ipcRenderer.invoke(IPC.openFolder, path) as Promise<string>,
  toolsOk: () => ipcRenderer.invoke(IPC.toolsOk) as Promise<boolean>,
}

contextBridge.exposeInMainWorld('api', api)
