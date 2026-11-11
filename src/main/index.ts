import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, safeStorage, session, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriveClient } from '../core/download/drive'
import { IPC as CARDS_IPC, type RunEventPayload as CardsRunEventPayload } from '../shared/cards-ipc'
import { cardListener } from './cards/cardinfo'
import { registerIpc as registerCardsIpc } from './cards/ipc'
import { Runner as CardsRunner, type Notice } from './cards/runner'
import { loadApiKey } from './cards/secrets'
import { loadSettings } from './cards/settings'
import { checkTools } from './cards/tools'
import { watchVolumes } from './cards/watcher'
import { CloseGuard, closeWhileRunningText, KEEP_RUNNING_BUTTON, STOP_AND_CLOSE_BUTTON } from './close-guard'
import { AuthService } from './download/auth'
import { registerIpc as registerDownloadIpc } from './download/ipc'
import { getOAuthConfig } from './download/oauth-config'
import { Runner as DownloadRunner } from './download/runner'
import { createTokenStore } from './download/token-store'
import { importTrideniData } from './migrate'

const here = fileURLToPath(new URL('.', import.meta.url))

function log(message: string): void {
  console.log(`[main] ${message}`)
}

let mainWindow: BrowserWindow | null = null
/** Asks before a close or quit stops a running download or card backup; set once the runners exist. */
let closeGuard: CloseGuard | null = null
/** Notifications are kept alive until they close, otherwise macOS may drop their click handlers. */
const liveNotifications = new Set<Notification>()
let stopWatching: (() => void) | undefined

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'Sportivea Záloha',
    webPreferences: {
      // Sandboxed preload scripts must be CommonJS; electron-vite emits index.cjs.
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No DevTools in the packaged app (the window holds the signed-in session).
      devTools: !app.isPackaged,
    },
  })
  mainWindow = window
  closeGuard?.rearm()
  // Closing the window during a run asks first; „Zastavit a zavřít“ stops what runs, then closes.
  window.on('close', (event) => {
    closeGuard?.handle(event, () => {
      if (!window.isDestroyed()) window.close()
    })
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const contents = window.webContents
  // The app never opens other windows or leaves its own page.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-redirect', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (event) => event.preventDefault())

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
    void contents
      .executeJavaScript(
        'typeof window.api?.cards?.getSettings === "function" && typeof window.api?.download?.authStatus === "function"',
      )
      .then((ready: unknown) => {
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
function sendToRenderer(channel: string, payload: unknown): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
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
    bringToFront()
  })
  n.show()
}

function bringToFront(): BrowserWindow {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return window
}

if (!app.requestSingleInstanceLock()) {
  // A second copy would run the same download twice and pick up every card twice.
  app.quit()
} else {
  void app.whenReady().then(async () => {
    // The app needs no web permissions (camera, notifications from the page, ...).
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

    // Registered after ready: createWindow must not run before the app is ready.
    app.on('second-instance', () => {
      bringToFront()
    })

    const userData = app.getPath('userData')
    // Once: take over the old Třídění karet settings and journal (copies only, the originals stay as they are).
    const { imported } = await importTrideniData({ fromDir: join(app.getPath('appData'), 'trideni-karet'), toDir: userData, log })
    if (imported.length > 0) log(`imported from Třídění karet: ${imported.join(', ')}`)

    // --- Stáhnout z Drivu
    const auth = new AuthService({
      config: getOAuthConfig,
      store: createTokenStore({ safeStorage, dir: userData }),
      openExternal: (url) => shell.openExternal(url),
      log: (m) => log(`auth: ${m}`),
    })
    const download = new DownloadRunner({
      send: (channel, payload) => sendToRenderer(channel, payload),
      powerSaveBlocker,
      // Drive calls use Node's global fetch (DriveClient default), not Electron's net module.
      makeClient: () => new DriveClient({ tokens: auth.tokens }),
      isSignedIn: () => auth.hasRefreshToken(),
      log: (m) => log(`download: ${m}`),
    })

    // --- Nahrát kartu
    const settingsFile = join(userData, 'settings.json')
    // once per start: without working ffprobe/ffmpeg no clip can be analysed, so no card run may start
    const tools = checkTools({ log })
    void tools.then((ok) => log(`tools ok=${String(ok)}`))
    const toolsOk = (): Promise<boolean> => tools
    const cards = new CardsRunner({
      getSettings: () => loadSettings(settingsFile),
      getApiKey: loadApiKey,
      journalFile: join(userData, 'journal.jsonl'),
      send: (payload: CardsRunEventPayload) => sendToRenderer(CARDS_IPC.runEvent, payload),
      notify: showNotification,
      toolsOk,
    })

    closeGuard = new CloseGuard({
      isRunning: () => download.isRunning() || cards.isBusy(),
      abort: () => {
        download.abort()
        cards.abort()
      },
      idle: () => Promise.all([download.idle(), cards.idle()]).then(() => undefined),
      confirm: async () => {
        const text = closeWhileRunningText(download.isRunning(), cards.isBusy())
        const options: Electron.MessageBoxOptions = {
          type: 'warning',
          message: text?.message ?? '',
          buttons: [text?.keepButton ?? KEEP_RUNNING_BUTTON, STOP_AND_CLOSE_BUTTON],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        }
        const window = mainWindow
        const { response } =
          window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
        return response === 1
      },
    })
    // Quitting during a run (Cmd+Q, Dock) asks first; „Zastavit a zavřít“ stops what runs, then quits.
    app.on('before-quit', (event) => {
      closeGuard?.handle(event, () => app.quit())
    })

    // Every IPC handler checks the sender (our window) and validates its input with Zod.
    registerDownloadIpc({
      ipcMain,
      window: () => mainWindow,
      auth,
      runner: download,
      pickDirectory: async () => {
        const options: Electron.OpenDialogOptions = {
          title: 'Vyber cíl na externím disku',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: '/Volumes',
        }
        const window = mainWindow
        const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
        const dir = picked.filePaths[0]
        return picked.canceled || dir === undefined ? null : dir
      },
      showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
      log,
    })
    registerCardsIpc({ window: () => mainWindow, runner: cards, settingsFile, toolsOk })

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    // a card that cannot be described yet is looked at again on the watcher's next poll
    stopWatching = watchVolumes(
      cardListener((root, card) => {
        cards.registerCard(root)
        bringToFront()
        app.focus({ steal: true })
        app.dock?.bounce('informational')
        sendToRenderer(CARDS_IPC.cardDetected, card)
      }),
    )
  })

  app.on('will-quit', () => {
    stopWatching?.()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
