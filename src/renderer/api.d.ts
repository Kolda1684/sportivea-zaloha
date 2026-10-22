import type { Api } from '../shared/ipc-types'

declare global {
  interface Window {
    /** Exposed by the preload script. */
    api: Api
  }
}
