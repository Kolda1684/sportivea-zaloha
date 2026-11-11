/**
 * Asks before a window close or app quit stops a running download or card backup. "Zastavit a zavřít" aborts the run, waits
 * (bounded) until it has finished writing its manifest, then lets the close or quit go through.
 */

export const CLOSE_WHILE_RUNNING_TEXT =
  'Stahování běží. Když aplikaci zavřeš, stahování se zastaví. Můžeš pak pokračovat tam, kde skončilo.'
export const KEEP_RUNNING_BUTTON = 'Pokračovat ve stahování'
export const STOP_AND_CLOSE_BUTTON = 'Zastavit a zavřít'
export const CARD_RUNNING_TEXT =
  'Záloha karty běží. Když aplikaci zavřeš, záloha se zastaví a karta NENÍ zálohovaná. Po dalším vložení karty vyber stejnou akci: záloha se dokončí a hotové soubory se znovu nenahrají.'
export const BOTH_RUNNING_TEXT =
  'Běží stahování i záloha karty. Když aplikaci zavřeš, obojí se zastaví a karta NENÍ zálohovaná. Stahování pak naváže tam, kde skončilo, kartu dokončíš po dalším vložení se stejnou akcí.'
export const KEEP_BOTH_RUNNING_BUTTON = 'Nechat běžet'

/** Dialog text for what is running right now; `null` when nothing runs (no dialog needed). */
export function closeWhileRunningText(download: boolean, cards: boolean): { message: string; keepButton: string } | null {
  if (download && cards) return { message: BOTH_RUNNING_TEXT, keepButton: KEEP_BOTH_RUNNING_BUTTON }
  if (download) return { message: CLOSE_WHILE_RUNNING_TEXT, keepButton: KEEP_RUNNING_BUTTON }
  if (cards) return { message: CARD_RUNNING_TEXT, keepButton: KEEP_BOTH_RUNNING_BUTTON }
  return null
}

/** How long a stopped run may take to finish (abort the write, write the manifest) before the app closes anyway. */
export const STOP_TIMEOUT_MS = 10_000

export type CloseGuardDeps = {
  isRunning: () => boolean
  abort: () => void
  /** Resolves when the current run has finished (manifest written, `run:done` sent). */
  idle: () => Promise<void>
  /** Shows the dialog; `true` = „Zastavit a zavřít“. A rejection counts as „Pokračovat ve stahování“. */
  confirm: () => Promise<boolean>
  timeoutMs?: number
}

export type PreventableEvent = { preventDefault: () => void }

export class CloseGuard {
  /** Set once the user chose to stop and close: every close/quit after that passes. */
  private released = false
  private asking: Promise<void> | null = null

  constructor(private readonly deps: CloseGuardDeps) {}

  /**
   * For a window `close` or an app `before-quit` event. While a run is active the event is prevented and the user
   * is asked (once, even if close and quit arrive together); `proceed` repeats the close/quit when allowed.
   */
  handle(event: PreventableEvent, proceed: () => void): void {
    if (this.released || !this.deps.isRunning()) return
    event.preventDefault()
    if (this.asking !== null) return
    this.asking = this.ask(proceed).finally(() => {
      this.asking = null
    })
  }

  /** A new window: closing it during a later run asks again. */
  rearm(): void {
    this.released = false
  }

  /** Resolves when no dialog is pending (for tests). */
  async settled(): Promise<void> {
    await this.asking
  }

  private async ask(proceed: () => void): Promise<void> {
    let stop: boolean
    try {
      stop = await this.deps.confirm()
    } catch {
      stop = false
    }
    if (!stop) return
    this.deps.abort()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deps.timeoutMs ?? STOP_TIMEOUT_MS)
    })
    try {
      await Promise.race([this.deps.idle().catch(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
    this.released = true
    proceed()
  }
}
