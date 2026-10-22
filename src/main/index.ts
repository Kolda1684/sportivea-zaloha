import { app, BrowserWindow, Notification } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type RunEventPayload } from '../shared/ipc-types'
import { describeCard } from './cardinfo'
import { registerIpc } from './ipc'
import { Runner, type Notice } from './runner'
import { loadApiKey } from './secrets'
import { loadSettings } from './settings'
import { watchVolumes } from './watcher'

const here = fileURLToPath(new URL('.', import.meta.url))

function log(message: string): void {
  console.log(`[main] ${message}`)
}

let mainWindow: BrowserWindow | null = null
/** Notifications are kept alive until they close, otherwise macOS may drop their click handlers. */
const liveNotifications = new Set<Notification>()
let stopWatching: (() => void) | undefined

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'Třídění karet',
    webPreferences: {
      // Sandboxed preload scripts must be CommonJS; electron-vite emits index.cjs.
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const contents = window.webContents
  // The app never opens other windows or leaves its own page.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())

  contents.on('preload-error', (_event, preloadPath, error) => {
    log(`preload-error ${preloadPath}: ${error.message}`)
  })
  contents.on('render-process-gone', (_event, details) => {
    log(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  contents.on('did-fail-load', (_event, code, description, url) => {
    log(`did-fail-load ${code} ${description} ${url}`)
  })
  contents.on('did-finish-load', () => {
    log('did-finish-load')
    void contents.executeJavaScript('typeof window.api === "object" && typeof window.api.getSettings === "function"').then((ready: unknown) => {
      log(`preload bridge ready=${String(ready)}`)
    })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(here, '../renderer/index.html'))
  }
  return window
}

/** Sends to the renderer once the page has loaded; silently drops the message when there is no window. */
function sendToRenderer(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!window || window.isDestroyed()) return
  const contents = window.webContents
  if (contents.isLoading()) {
    contents.once('did-finish-load', () => {
      if (!window.isDestroyed()) contents.send(channel, payload)
    })
  } else {
    contents.send(channel, payload)
  }
}

function showNotification(notice: Notice): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: notice.title, body: notice.body })
  liveNotifications.add(n)
  n.on('close', () => liveNotifications.delete(n))
  n.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  n.show()
}

function bringToFront(): BrowserWindow {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  app.focus({ steal: true })
  return window
}

if (!app.requestSingleInstanceLock()) {
  // A second copy would watch the same cards and start every backup twice.
  app.quit()
} else {
  app.on('second-instance', () => {
    bringToFront()
  })

  void app.whenReady().then(() => {
    const userData = app.getPath('userData')
    const settingsFile = join(userData, 'settings.json')

    const runner = new Runner({
      getSettings: () => loadSettings(settingsFile),
      getApiKey: loadApiKey,
      journalFile: join(userData, 'journal.jsonl'),
      send: (payload: RunEventPayload) => sendToRenderer(mainWindow, IPC.runEvent, payload),
      notify: showNotification,
    })
    registerIpc({ window: () => mainWindow, runner, settingsFile })

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    stopWatching = watchVolumes((root) => {
      void describeCard(root).then((card) => {
        if (!card) return
        runner.registerCard(root)
        const window = bringToFront()
        app.dock?.bounce('informational')
        sendToRenderer(window, IPC.cardDetected, card)
      })
    })
  })

  app.on('will-quit', () => {
    stopWatching?.()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
