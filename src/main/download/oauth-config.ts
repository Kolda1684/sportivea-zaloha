export interface OAuthConfig {
  clientId: string
  clientSecret: string
}

/** Pure check of the two OAuth client values; throws a Czech message when either is empty. */
export function resolveOAuthConfig(clientId: string, clientSecret: string): OAuthConfig {
  if (clientId === '' || clientSecret === '') {
    throw new Error('Chybí nastavení přihlášení Google (OAuth klient).')
  }
  return { clientId, clientSecret }
}

/** OAuth client values baked into the main bundle at build time (see electron.vite.config.ts). */
export function getOAuthConfig(): OAuthConfig {
  return resolveOAuthConfig(__GOOGLE_OAUTH_CLIENT_ID__, __GOOGLE_OAUTH_CLIENT_SECRET__)
}
