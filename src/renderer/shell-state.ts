/** Which screen the shell shows. Both modes stay mounted whatever the view is. */
export type ShellView = 'home' | 'download' | 'cards' | 'settings'
export type ShellState = { view: ShellView; returnTo: Exclude<ShellView, 'settings'> }
export type ShellAction =
  | { type: 'open'; view: Exclude<ShellView, 'settings'> }
  | { type: 'openSettings' }
  | { type: 'closeSettings' }
  | { type: 'cardArrived' }

export function initialShell(): ShellState {
  return { view: 'home', returnTo: 'home' }
}

export function reduceShell(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case 'open':
      return { ...state, view: action.view }
    case 'openSettings':
      return state.view === 'settings' ? state : { view: 'settings', returnTo: state.view }
    case 'closeSettings':
      return state.view === 'settings' ? { ...state, view: state.returnTo } : state
    case 'cardArrived':
      // a new card shows up in the cards mode; in the settings it waits there until they are closed
      return state.view === 'settings' ? { ...state, returnTo: 'cards' } : { ...state, view: 'cards' }
  }
}

/** Home line for a running download; `null` when no download runs. */
export function downloadStatusText(progress: { doneBytes: number; totalBytes: number } | null): string | null {
  if (progress === null) return null
  const pct = progress.totalBytes > 0 ? Math.round((progress.doneBytes / progress.totalBytes) * 100) : 0
  return `Stahuje se – ${pct} %`
}

/** Home line for the cards mode; `null` when there is nothing to report. */
export function cardsStatusText(input: { activeVolume: string | null; activeCount: number; pending: number }): string | null {
  if (input.activeVolume !== null && input.activeCount > 0) {
    const more = input.activeCount - 1
    return `Karta ${input.activeVolume} – zálohuje se${more > 0 ? ` (další ve frontě: ${more})` : ''}`
  }
  if (input.pending > 0) return 'Čeká nová karta'
  return null
}
