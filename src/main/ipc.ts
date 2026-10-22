import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { IPC, type CardDetected, type PickPurpose, type Result, type SettingsResult } from '../shared/ipc-types'
import { describeCard } from './cardinfo'
import { resolveInsideRoot, RootFolderGuard } from './guards'
import { listEvents, type Runner } from './runner'
import { loadApiKey, saveApiKey } from './secrets'
import { loadSettings, parseSettingsPatch, saveSettings } from './settings'

export type IpcContext = {
  window(): BrowserWindow | null
  runner: Runner
  settingsFile: string
  /** Startup check of ffprobe/ffmpeg (run once). */
  toolsOk(): Promise<boolean>
}

const purposeSchema = z.enum(['card', 'root'])
const apiKeySchema = z.string().trim().min(1).max(500)
const pathSchema = z.string().min(1).max(4096)

/** Registers every `ipcMain.handle`. Only the main window's own frames may call them. */
export function registerIpc(ctx: IpcContext): void {
  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (event: IpcMainInvokeEvent, ...args: A): Promise<R> => {
      const win = ctx.window()
      if (!win || event.sender !== win.webContents) throw new Error('Nepovolené volání.')
      return fn(...args)
    }

  const rootGuard = new RootFolderGuard()

  // settings.json is read-modify-write: serialise the writers so that two patches cannot overwrite each other
  let settingsLock: Promise<unknown> = Promise.resolve()

  ipcMain.handle(
    IPC.settingsGet,
    guarded(async () => loadSettings(ctx.settingsFile)),
  )

  ipcMain.handle(
    IPC.settingsSet,
    guarded(async (raw: unknown): Promise<SettingsResult> => {
      const parsed = parseSettingsPatch(raw)
      if (!parsed.ok) return parsed
      const patch = parsed.patch
      const run = settingsLock.then(async (): Promise<SettingsResult> => {
        const current = await loadSettings(ctx.settingsFile)
        // the root folder can only be set to what the user chose in the folder dialog (or cleared)
        if (patch.rootDir !== undefined && !(await rootGuard.allows(patch.rootDir, current.rootDir))) {
          return { ok: false, error: 'Složku pro akce vyber tlačítkem Vybrat složku, jinou cestu nejde nastavit.' }
        }
        const merged = { ...current, ...patch }
        try {
          await saveSettings(ctx.settingsFile, merged)
        } catch (e) {
          return { ok: false, error: `Nastavení se nepodařilo uložit: ${e instanceof Error ? e.message : String(e)}` }
        }
        return { ok: true, settings: merged }
      })
      settingsLock = run.catch(() => undefined)
      return run
    }),
  )

  ipcMain.handle(
    IPC.apiKeySet,
    guarded(async (raw: unknown): Promise<Result> => {
      const parsed = apiKeySchema.safeParse(raw)
      if (!parsed.success) return { ok: false, error: 'Klíč je prázdný nebo příliš dlouhý.' }
      try {
        await saveApiKey(parsed.data)
        return { ok: true }
      } catch (e) {
        // the message never contains the key
        return { ok: false, error: e instanceof Error ? e.message : 'Klíč se nepodařilo uložit.' }
      }
    }),
  )

  ipcMain.handle(
    IPC.apiKeyHas,
    guarded(async (): Promise<boolean> => (await loadApiKey()) !== null),
  )

  ipcMain.handle(
    IPC.toolsOk,
    guarded(async (): Promise<boolean> => ctx.toolsOk()),
  )

  ipcMain.handle(
    IPC.eventsList,
    guarded(async (): Promise<string[]> => listEvents((await loadSettings(ctx.settingsFile)).rootDir)),
  )

  ipcMain.handle(
    IPC.runStart,
    guarded(async (raw: unknown): Promise<Result> => ctx.runner.start(raw)),
  )

  ipcMain.handle(
    IPC.pickFolder,
    guarded(async (rawPurpose: unknown): Promise<CardDetected | string | null> => {
      const purpose: PickPurpose = purposeSchema.catch('card').parse(rawPurpose)
      const win = ctx.window()
      const options: Electron.OpenDialogOptions =
        purpose === 'root'
          ? {
              title: 'Vyber složku na Google Disku, do které se budou ukládat akce',
              properties: ['openDirectory', 'createDirectory'],
              defaultPath: join(app.getPath('home'), 'Library', 'CloudStorage'),
            }
          : { title: 'Vyber složku s kartou', properties: ['openDirectory'], defaultPath: '/Volumes' }
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      const dir = picked.filePaths[0]
      if (picked.canceled || dir === undefined) return null
      if (purpose === 'root') {
        await rootGuard.recordPick(dir)
        return dir
      }
      const info = await describeCard(dir)
      if (info) ctx.runner.registerCard(dir)
      return info
    }),
  )

  ipcMain.handle(
    IPC.openFolder,
    guarded(async (raw: unknown): Promise<string> => {
      const parsed = pathSchema.safeParse(raw)
      if (!parsed.success) return 'Neplatná cesta.'
      const { rootDir } = await loadSettings(ctx.settingsFile)
      const target = await resolveInsideRoot(rootDir, parsed.data)
      if (target === null) return 'Tuhle složku nejde otevřít.'
      shell.showItemInFolder(target) // reveals in Finder, never launches anything
      return ''
    }),
  )
}
