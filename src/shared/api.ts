import type { CardsApi } from './cards-ipc'
import type { DownloadApi } from './download-ipc'

/** `window.api`: the preload script exposes one typed surface per mode. */
export type AppApi = { download: DownloadApi; cards: CardsApi }
