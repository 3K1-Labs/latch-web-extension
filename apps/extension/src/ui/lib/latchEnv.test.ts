import { describe, expect, it } from 'vitest'
import { DEFAULT_WEBAUTHN_RP_ID, latchWebauthnRpId, normalizeWebauthnRpId } from './latchEnv'

describe('latchEnv webauthn RP ID', () => {
  it('normalizeWebauthnRpId strips protocol and path', () => {
    expect(normalizeWebauthnRpId('uselatch.app')).toBe('uselatch.app')
    expect(normalizeWebauthnRpId('https://uselatch.app/')).toBe('uselatch.app')
    expect(normalizeWebauthnRpId('https://UseLatch.App/foo')).toBe('uselatch.app')
  })

  it('latchWebauthnRpId defaults to uselatch.app', () => {
    expect(DEFAULT_WEBAUTHN_RP_ID).toBe('uselatch.app')
    expect(latchWebauthnRpId()).toBe('uselatch.app')
  })
})
