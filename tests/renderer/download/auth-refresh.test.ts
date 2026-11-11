import { describe, expect, it } from 'vitest'
import { afterAuthCheck } from '../../../src/renderer/download/auth-refresh'

describe('afterAuthCheck', () => {
  it('a sign-out elsewhere drops the loaded folder and asks to sign in', () => {
    expect(afterAuthCheck('choose', false)).toEqual({ screen: 'signin', reset: true })
  })
  it('keeps every other screen', () => {
    expect(afterAuthCheck('choose', true)).toEqual({ screen: 'choose', reset: false })
    expect(afterAuthCheck('progress', false)).toEqual({ screen: 'progress', reset: false })
    expect(afterAuthCheck('done', false)).toEqual({ screen: 'done', reset: false })
    expect(afterAuthCheck('signin', false)).toEqual({ screen: 'signin', reset: false })
    expect(afterAuthCheck('loading', true)).toEqual({ screen: 'loading', reset: false })
  })
})
