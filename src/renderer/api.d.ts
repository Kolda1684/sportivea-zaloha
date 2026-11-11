import type { AppApi } from '../shared/api'

declare global {
  interface Window {
    /** Exposed by the preload script. */
    api: AppApi
  }
}
