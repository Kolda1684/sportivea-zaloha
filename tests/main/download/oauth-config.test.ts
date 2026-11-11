import { describe, expect, it } from 'vitest'
import { getOAuthConfig, resolveOAuthConfig } from '../../../src/main/download/oauth-config'

const MISSING = 'Chybí nastavení přihlášení Google (OAuth klient).'

describe('resolveOAuthConfig', () => {
  it('returns both values when set', () => {
    expect(resolveOAuthConfig('id.apps.googleusercontent.com', 'GOCSPX-x')).toEqual({
      clientId: 'id.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-x',
    })
  })

  it('throws the Czech message when the client id is empty', () => {
    expect(() => resolveOAuthConfig('', 'GOCSPX-x')).toThrow(MISSING)
  })

  it('throws the Czech message when the client secret is empty', () => {
    expect(() => resolveOAuthConfig('id.apps.googleusercontent.com', '')).toThrow(MISSING)
  })
})

describe('getOAuthConfig', () => {
  it('throws when the build-time constants are empty (vitest defines them as "")', () => {
    expect(() => getOAuthConfig()).toThrow(MISSING)
  })
})
