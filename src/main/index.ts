import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

function log(message: string): void {
  console.log(`[main] ${message}`)
}

function createWindow(): void {
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

  const contents = window.webContents
  contents.on('preload-error', (_event, preloadPath, error) => {
    log(`preload-error ${preloadPath}: ${error.message}`)
  })
  contents.on('render-process-gone', (_event, details) => {
    log(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  contents.on('did-fail-load', (_event, code, description, url) => {
    log(`did-fail-load ${code} ${description} ${url}`)
  })
  contents.on('console-message', (event) => {
    log(`console[${event.level}] ${event.message}`)
  })
  contents.on('did-finish-load', () => {
    log('did-finish-load')
    void contents
      .executeJavaScript('typeof window.trideni === "object" && window.trideni.ready === true')
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
}

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
