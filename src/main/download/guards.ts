import * as fs from 'node:fs/promises'

/** The parts of a frame used to identify it (Electron `WebFrameMain`). */
export type FrameLike = { processId: number; routingId: number }

/** The parts of an IPC event the sender check uses (Electron `IpcMainInvokeEvent`). */
export type SenderEvent = { sender: unknown; senderFrame: FrameLike | null }

/** The parts of the main window the sender check uses (Electron `BrowserWindow`). */
export type WindowLike = { isDestroyed(): boolean; webContents: { mainFrame: FrameLike } }

/**
 * The one sender check for every IPC handler: the call must come from the main window's own webContents and from
 * its main frame (not a subframe, not another window). Distinct `WebFrameMain` objects for the same frame share
 * `processId` and `routingId`.
 */
export function isTrustedSender(event: SenderEvent, win: WindowLike | null): boolean {
  if (win === null || win.isDestroyed()) return false
  if (event.sender !== win.webContents) return false
  const frame = event.senderFrame
  if (frame === null) return false
  const main = win.webContents.mainFrame
  return frame === main || (frame.processId === main.processId && frame.routingId === main.routingId)
}

/** Whether `p` is a real directory (lstat: a symlink does not count). */
export async function isRealDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory()
  } catch {
    return false
  }
}
