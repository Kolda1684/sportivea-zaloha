import { contextBridge } from 'electron'

// Placeholder bridge; the real API is added in later tasks.
contextBridge.exposeInMainWorld('trideni', { ready: true })
