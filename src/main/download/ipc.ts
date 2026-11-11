import { z } from 'zod'
import {
  IPC,
  type AuthStatus,
  type DestPickResult,
  type RunStatusInfo,
  type ScanResult,
  type SignInResult,
  type SignOutResult,
  type StartResult,
} from '../../shared/download-ipc'
import type { AuthService } from './auth'
import { isRealDirectory, isTrustedSender, type SenderEvent, type WindowLike } from './guards'
import type { Runner } from './runner'

export type { SenderEvent } from './guards'

export const INVALID_REQUEST = 'Neplatný požadavek.'
const FAILED = 'Něco se nepovedlo. Zkus to znovu.'
const SCAN_UNKNOWN = 'Složka už není načtená. Načti ji znovu.'
export const SIGN_OUT_WHILE_RUNNING = 'Během stahování se nejde odhlásit.'

type Listener = (event: SenderEvent, ...args: unknown[]) => Promise<unknown>

export type IpcDeps = {
  /** Electron `ipcMain` (only `handle` is used). */
  ipcMain: { handle(channel: string, listener: Listener): void }
  window: () => WindowLike | null
  auth: Pick<AuthService, 'status' | 'signIn' | 'signOut'>
  runner: Runner
  /** Native folder dialog (openDirectory, createDirectory); `null` when cancelled. The only source of a destination. */
  pickDirectory: () => Promise<string | null>
  /** `shell.showItemInFolder` */
  showItemInFolder: (fullPath: string) => void
  log: (message: string) => void
}

const noArgs = z.tuple([])
const linkArgs = z.tuple([z.string().min(1).max(2048)])
const scanIdArgs = z.tuple([z.string().min(1).max(100)])

const resultError = (error: string): { ok: false; error: string } => ({ ok: false, error })
const signedOut = (): AuthStatus => ({ signedIn: false, email: null })
const nothing = (): undefined => undefined

/**
 * Registers every `ipcMain.handle`. Each handler checks the sender (main window, main frame) and validates its
 * arguments with Zod. A foreign sender, invalid arguments or an exception never reach the renderer as a thrown
 * error: the handler returns its Czech error value (or nothing) instead.
 */
export function registerIpc(deps: IpcDeps): void {
  function handle<S extends z.ZodType<unknown[]>, R>(
    channel: string,
    schema: S,
    fallback: (error: string) => R,
    fn: (args: z.infer<S>) => Promise<R>,
  ): void {
    deps.ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event, deps.window())) {
        deps.log(`blocked ${channel} from a foreign sender`)
        return fallback(INVALID_REQUEST)
      }
      const parsed = schema.safeParse(args)
      if (!parsed.success) return fallback(INVALID_REQUEST)
      try {
        return await fn(parsed.data)
      } catch (e) {
        // Only the error name: messages could carry paths or tokens.
        deps.log(`${channel} failed (${e instanceof Error ? e.name : typeof e})`)
        return fallback(FAILED)
      }
    })
  }

  handle(IPC.ping, noArgs, () => undefined, async (): Promise<'pong' | undefined> => 'pong')

  handle(IPC.authStatus, noArgs, signedOut, (): Promise<AuthStatus> => deps.auth.status())
  handle(IPC.authSignIn, noArgs, resultError, (): Promise<SignInResult> => deps.auth.signIn())
  handle(IPC.authSignOut, noArgs, resultError, async (): Promise<SignOutResult> => {
    // The renderer disables the button too, but the rule belongs here: a sign-out would drop the token mid-run.
    if (deps.runner.isRunning()) return resultError(SIGN_OUT_WHILE_RUNNING)
    await deps.auth.signOut()
    return { ok: true }
  })

  handle(IPC.driveScan, linkArgs, resultError, ([link]): Promise<ScanResult> => deps.runner.scan(link))

  handle(IPC.destPick, scanIdArgs, resultError, async ([scanId]): Promise<DestPickResult> => {
    if (!deps.runner.hasScan(scanId)) return resultError(SCAN_UNKNOWN)
    const dir = await deps.pickDirectory()
    if (dir === null) return null
    return deps.runner.setDestination(scanId, dir)
  })

  handle(IPC.runStart, scanIdArgs, resultError, ([scanId]): Promise<StartResult> => deps.runner.start(scanId))
  handle(IPC.runRetryFailed, noArgs, resultError, (): Promise<StartResult> => deps.runner.retryFailed())
  handle(IPC.runStatus, noArgs, (): RunStatusInfo => ({ running: false }), async (): Promise<RunStatusInfo> => deps.runner.status())
  handle(IPC.runAbort, noArgs, nothing, async (): Promise<undefined> => {
    deps.runner.abort()
    return undefined
  })

  handle(IPC.shellShowDest, noArgs, nothing, async (): Promise<undefined> => {
    const destRoot = deps.runner.destRootToShow()
    // Only the run's own destination, and only while it is a real directory; reveals, never opens anything.
    if (destRoot !== null && (await isRealDirectory(destRoot))) deps.showItemInFolder(destRoot)
    return undefined
  })
}
