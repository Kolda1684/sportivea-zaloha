import type { CardsApi } from '../../shared/cards-ipc'

/** The cards half of `window.api`; read lazily so that modules load without a window (tests). */
export function api(): CardsApi {
  return window.api.cards
}
