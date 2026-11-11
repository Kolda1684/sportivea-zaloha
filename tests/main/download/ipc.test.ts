import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Preflight } from '../../../src/core/download/preflight'
import { isTrustedSender } from '../../../src/main/download/guards'
import { INVALID_REQUEST, registerIpc, type IpcDeps, type SenderEvent } from '../../../src/main/download/ipc'
import type { Runner } from '../../../src/main/download/runner'
import { IPC } from '../../../src/shared/download-ipc'

const SECRET = '1//refresh-SECRET-xyz'

type Listener = (event: SenderEvent, ...args: unknown[]) => unknown

const mainFrame = { processId: 4, routingId: 1 }
const webContents = { mainFrame }
const win = { isDestroyed: () => false, webContents }
const goodEvent: SenderEvent = { sender: webContents, senderFrame: { processId: 4, routingId: 1 } }

let handlers: Map<string, Listener>
let calls: string[]
let revealed: string[]
let picked: string | null
let tmp: string
let destRoot: string | null
let running: boolean

const PREFLIGHT: Preflight = {
  destRoot: '/Volumes/X/Klient',
  state: 'new',
  lastRunAt: null,
  freeBytes: 1,
  neededBytes: 1,
  problem: null,
  warning: null,
}

function fakeRunner(): Runner {
  const r = {
    hasScan: (id: string) => id === 'scan-1',
    scan: async (link: string) => {
      calls.push(`scan:${link}`)
      return { ok: true as const, scanId: 'scan-1', plan: { rootName: 'K', fileCount: 0, folderCount: 0, totalBytes: 0, skipped: 0 } }
    },
    setDestination: async (id: string, dir: string) => {
      calls.push(`dest:${id}:${dir}`)
      return { ok: true as const, preflight: PREFLIGHT }
    },
    start: async (id: string) => {
      calls.push(`start:${id}`)
      return { ok: true as const }
    },
    retryFailed: async () => {
      calls.push('retry')
      return { ok: true as const }
    },
    abort: () => {
      calls.push('abort')
    },
    destRootToShow: () => destRoot,
    isRunning: () => running,
    status: () => {
      calls.push('status')
      return running
        ? { running: true as const, filesDone: 1, filesTotal: 2, doneBytes: 3, totalBytes: 4, currentPath: 'K/a.mp4' }
        : { running: false as const }
    },
  }
  return r as unknown as Runner
}

function register(over: Partial<IpcDeps> = {}): void {
  registerIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    window: () => win,
    auth: {
      status: async () => ({ signedIn: true, email: 'jan@sportivea.cz' }),
      signIn: async () => ({ ok: true, email: 'jan@sportivea.cz' }),
      signOut: async () => {
        calls.push('signOut')
      },
    },
    runner: fakeRunner(),
    pickDirectory: async () => {
      calls.push('dialog')
      return picked
    },
    showItemInFolder: (p) => revealed.push(p),
    log: () => undefined,
    ...over,
  })
}

async function invoke(channel: string, event: SenderEvent, ...args: unknown[]): Promise<unknown> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h(event, ...args)
}

beforeEach(async () => {
  handlers = new Map()
  calls = []
  revealed = []
  picked = '/Volumes/X'
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-test-'))
  destRoot = null
  running = false
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('isTrustedSender', () => {
  it('accepts only the main window main frame', () => {
    expect(isTrustedSender(goodEvent, win)).toBe(true)
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame }, win)).toBe(true)
    expect(isTrustedSender({ sender: {}, senderFrame: mainFrame }, win)).toBe(false)
    expect(isTrustedSender({ sender: webContents, senderFrame: null }, win)).toBe(false)
    expect(isTrustedSender({ sender: webContents, senderFrame: { processId: 4, routingId: 2 } }, win)).toBe(false)
    expect(isTrustedSender({ sender: webContents, senderFrame: { processId: 5, routingId: 1 } }, win)).toBe(false)
    expect(isTrustedSender(goodEvent, null)).toBe(false)
    expect(isTrustedSender(goodEvent, { isDestroyed: () => true, webContents })).toBe(false)
  })
})

describe('registerIpc', () => {
  it('registers every channel', () => {
    register()
    for (const channel of [
      IPC.ping,
      IPC.authStatus,
      IPC.authSignIn,
      IPC.authSignOut,
      IPC.driveScan,
      IPC.destPick,
      IPC.runStart,
      IPC.runAbort,
      IPC.runRetryFailed,
      IPC.runStatus,
      IPC.shellShowDest,
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('a foreign sender gets nothing done and no exception', async () => {
    register()
    const foreign: SenderEvent = { sender: {}, senderFrame: mainFrame }
    expect(await invoke(IPC.driveScan, foreign, 'link')).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(await invoke(IPC.runStart, foreign, 'scan-1')).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(await invoke(IPC.authStatus, foreign)).toEqual({ signedIn: false, email: null })
    expect(await invoke(IPC.authSignOut, foreign)).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(await invoke(IPC.runAbort, foreign)).toBeUndefined()
    expect(await invoke(IPC.runStatus, foreign)).toEqual({ running: false })
    expect(calls).toEqual([])
  })

  it('run:status returns the runner status and refuses arguments', async () => {
    register()
    running = true
    expect(await invoke(IPC.runStatus, goodEvent)).toEqual({
      running: true,
      filesDone: 1,
      filesTotal: 2,
      doneBytes: 3,
      totalBytes: 4,
      currentPath: 'K/a.mp4',
    })
    expect(await invoke(IPC.runStatus, goodEvent, 'x')).toEqual({ running: false })
  })

  it('invalid payloads are rejected with a Czech error object, never thrown', async () => {
    register()
    expect(await invoke(IPC.driveScan, goodEvent, 42)).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(await invoke(IPC.driveScan, goodEvent)).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(await invoke(IPC.driveScan, goodEvent, 'x'.repeat(5000))).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(await invoke(IPC.runStart, goodEvent, { id: 1 })).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(await invoke(IPC.destPick, goodEvent, null)).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(INVALID_REQUEST).toMatch(/[ýáíéěů]/)
    expect(calls).toEqual([])
  })

  it('dest:pick refuses an unknown scanId before opening the dialog', async () => {
    register()
    expect(await invoke(IPC.destPick, goodEvent, 'other')).toEqual({ ok: false, error: 'Složka už není načtená. Načti ji znovu.' })
    expect(calls).toEqual([])
  })

  it('dest:pick takes the folder only from the dialog; cancel returns null', async () => {
    register()
    expect(await invoke(IPC.destPick, goodEvent, 'scan-1', '/etc')).toEqual({ ok: false, error: INVALID_REQUEST })
    expect(await invoke(IPC.destPick, goodEvent, 'scan-1')).toEqual({ ok: true, preflight: PREFLIGHT })
    expect(calls).toEqual(['dialog', 'dest:scan-1:/Volumes/X'])
    picked = null
    expect(await invoke(IPC.destPick, goodEvent, 'scan-1')).toBeNull()
  })

  it('passes valid calls through', async () => {
    register()
    expect(await invoke(IPC.ping, goodEvent)).toBe('pong')
    expect(await invoke(IPC.driveScan, goodEvent, 'https://drive.google.com/drive/folders/abc')).toMatchObject({ ok: true })
    expect(await invoke(IPC.runStart, goodEvent, 'scan-1')).toEqual({ ok: true })
    expect(await invoke(IPC.runRetryFailed, goodEvent)).toEqual({ ok: true })
    await invoke(IPC.runAbort, goodEvent)
    expect(await invoke(IPC.authSignOut, goodEvent)).toEqual({ ok: true })
    expect(calls).toEqual(['scan:https://drive.google.com/drive/folders/abc', 'start:scan-1', 'retry', 'abort', 'signOut'])
  })

  it('refuses to sign out while a run is active', async () => {
    register()
    running = true
    expect(await invoke(IPC.authSignOut, goodEvent)).toEqual({ ok: false, error: 'Během stahování se nejde odhlásit.' })
    expect(calls).toEqual([])
    running = false
    expect(await invoke(IPC.authSignOut, goodEvent)).toEqual({ ok: true })
    expect(calls).toEqual(['signOut'])
  })

  it('a throwing service becomes a Czech error object', async () => {
    register({
      auth: {
        status: async () => {
          throw new Error(`boom ${SECRET}`)
        },
        signIn: async () => {
          throw new Error(`boom ${SECRET}`)
        },
        signOut: async () => undefined,
      },
    })
    const signIn = await invoke(IPC.authSignIn, goodEvent)
    expect(signIn).toMatchObject({ ok: false })
    expect(JSON.stringify(signIn)).not.toContain(SECRET)
    expect(await invoke(IPC.authStatus, goodEvent)).toEqual({ signedIn: false, email: null })
  })

  it('shell:showDest reveals only the run destination when it is a real directory', async () => {
    register()
    await invoke(IPC.shellShowDest, goodEvent)
    expect(revealed).toEqual([])
    destRoot = path.join(tmp, 'Klient')
    await invoke(IPC.shellShowDest, goodEvent)
    expect(revealed).toEqual([])
    await fs.mkdir(destRoot)
    await invoke(IPC.shellShowDest, goodEvent, '/etc/passwd')
    expect(revealed).toEqual([])
    await invoke(IPC.shellShowDest, goodEvent)
    expect(revealed).toEqual([destRoot])
  })
})
