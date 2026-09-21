import { describe, expect, it } from 'vitest'

import {
  assertTrustedDappOrigin,
  isAllowedDappWebOrigin,
  payloadOriginMismatch,
  resolveTrustedDappOrigin,
  trustedDappOriginFromSender,
} from './trustedOrigin'

describe('isAllowedDappWebOrigin', () => {
  it('allows https origins', () => {
    expect(isAllowedDappWebOrigin('https://app.example')).toBe(true)
    expect(isAllowedDappWebOrigin('https://app.example:8443')).toBe(true)
  })

  it('allows loopback http only', () => {
    expect(isAllowedDappWebOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedDappWebOrigin('http://127.0.0.1')).toBe(true)
    expect(isAllowedDappWebOrigin('http://[::1]:8080')).toBe(true)
    expect(isAllowedDappWebOrigin('http://evil.example')).toBe(false)
  })

  it('rejects opaque and dangerous schemes', () => {
    expect(isAllowedDappWebOrigin('null')).toBe(false)
    expect(isAllowedDappWebOrigin('file:///tmp/x')).toBe(false)
    expect(isAllowedDappWebOrigin('javascript:alert(1)')).toBe(false)
    expect(isAllowedDappWebOrigin('data:text/html,hi')).toBe(false)
    expect(isAllowedDappWebOrigin('')).toBe(false)
  })
})

describe('trustedDappOriginFromSender', () => {
  it('prefers sender.url over tab.url (iframe must not inherit parent)', () => {
    expect(
      trustedDappOriginFromSender({
        url: 'https://iframe.example/embed',
        tab: { id: 1, url: 'https://parent.example/' },
        origin: 'https://iframe.example',
      })
    ).toBe('https://iframe.example')
  })

  it('falls back to tab.url then sender.origin', () => {
    expect(
      trustedDappOriginFromSender({
        tab: { id: 2, url: 'http://localhost:3000/app' },
      })
    ).toBe('http://localhost:3000')

    expect(
      trustedDappOriginFromSender({
        origin: 'https://app.example',
      })
    ).toBe('https://app.example')
  })

  it('returns null when nothing usable is attested', () => {
    expect(trustedDappOriginFromSender(undefined)).toBeNull()
    expect(trustedDappOriginFromSender({})).toBeNull()
    expect(trustedDappOriginFromSender({ origin: 'null' })).toBeNull()
  })
})

describe('resolveTrustedDappOrigin / assertTrustedDappOrigin', () => {
  it('rejects disallowed schemes even when Chrome attested a URL', () => {
    expect(
      resolveTrustedDappOrigin({ url: 'file:///Users/me/page.html', origin: 'null' })
    ).toBeNull()
    expect(resolveTrustedDappOrigin({ url: 'http://evil.example/' })).toBeNull()
  })

  it('allows https and loopback http', () => {
    expect(resolveTrustedDappOrigin({ url: 'https://app.example/path' })).toBe(
      'https://app.example'
    )
    expect(resolveTrustedDappOrigin({ tab: { url: 'http://localhost:3000/' } })).toBe(
      'http://localhost:3000'
    )
  })

  it('assertTrustedDappOrigin throws with invalid_origin', () => {
    expect(() => assertTrustedDappOrigin({})).toThrow(/Missing or unsupported dapp origin/)
    try {
      assertTrustedDappOrigin({})
    } catch (e) {
      expect((e as { code?: string }).code).toBe('invalid_origin')
    }
  })
})

describe('payloadOriginMismatch', () => {
  it('returns undefined when payload origin is absent or matches', () => {
    expect(payloadOriginMismatch({}, 'https://app.example')).toBeUndefined()
    expect(
      payloadOriginMismatch({ origin: 'https://app.example' }, 'https://app.example')
    ).toBeUndefined()
  })

  it('returns origin_mismatch when payload claims another site', () => {
    const err = payloadOriginMismatch({ origin: 'https://spoof.example' }, 'https://app.example')
    expect(err?.code).toBe('origin_mismatch')
  })
})
