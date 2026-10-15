import { describe, expect, it, vi } from 'vitest'

import { formatFundError } from './fundErrors'

describe('formatFundError', () => {
  it('says the app is pointed at the wrong deployment', () => {
    expect(
      formatFundError({
        code: 'network_mismatch',
        message: 'Latch API issued a testnet challenge while the wallet is on mainnet.',
      })
    ).toBe('Latch is pointed at the wrong deployment.')
    expect(formatFundError({ code: 'NETWORK_MISMATCH', message: 'network mismatch' })).toBe(
      'Latch is pointed at the wrong deployment.'
    )
  })

  it('does not blame only WEBAUTHN_ALLOWED_ORIGINS for UNAUTHORIZED', () => {
    vi.stubGlobal('chrome', { runtime: { id: 'ext123' } })
    const msg = formatFundError({
      code: 'UNAUTHORIZED',
      message: 'signature verification failed',
      status: 401,
    })
    expect(msg).toMatch(/wrong Stellar network/i)
    expect(msg).toMatch(/WebAuthn signer/i)
    expect(msg).toMatch(/chrome-extension:\/\/ext123/)
    expect(msg).not.toMatch(/^signature verification failed The API must allow origin/)
    vi.unstubAllGlobals()
  })

  it('adds a factory-address diagnostic note when relevant', () => {
    const msg = formatFundError(
      { code: 'UNAUTHORIZED', message: 'signature verification failed' },
      {
        wallet: 'CCATLEKRXNV7OXJ2OD3BHFVAZG4A2KRS6VPSD7BO6KTBL6YHX5MESRJ5',
      }
    )
    expect(msg).toMatch(/empty factory C-address/i)
  })

  it('treats deposit INTERNAL_ERROR as a funding-service failure', () => {
    const msg = formatFundError({
      code: 'INTERNAL_ERROR',
      message: 'internal error',
      status: 500,
    })
    expect(msg).toMatch(/funding service|relayer/i)
    expect(msg).toMatch(/not a passkey problem/i)
    expect(msg).not.toMatch(/deploying the smart account/i)
  })

  it('explains moonpay_unsigned_url', () => {
    expect(formatFundError({ code: 'moonpay_unsigned_url', message: 'missing signature' })).toMatch(
      /missing signature/
    )
  })

  it('explains transak_missing_widget_url', () => {
    expect(formatFundError({ code: 'transak_missing_widget_url' })).toMatch(/Transak/i)
    expect(formatFundError({ code: 'transak_missing_widget_url' })).toMatch(/widget_url/)
  })
})
