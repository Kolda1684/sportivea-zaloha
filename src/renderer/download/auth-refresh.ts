export type DownloadScreen = 'loading' | 'signin' | 'choose' | 'progress' | 'done'

/**
 * What the download mode shows after it re-reads the sign-in (e.g. after „Odhlásit“ in the settings): a loaded
 * folder plan belongs to the old sign-in and is dropped (`reset`), the user signs in again. Progress and the
 * result screen stay: Done already handles a missing sign-in itself.
 */
export function afterAuthCheck(screen: DownloadScreen, signedIn: boolean): { screen: DownloadScreen; reset: boolean } {
  if (!signedIn && screen === 'choose') return { screen: 'signin', reset: true }
  return { screen, reset: false }
}
