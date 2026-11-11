import type { DownloadApi } from '../../shared/download-ipc'

/** The download half of `window.api`; read lazily so that modules load without a window (tests). */
export function api(): DownloadApi {
  return window.api.download
}
