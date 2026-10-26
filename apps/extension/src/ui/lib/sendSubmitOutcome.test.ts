import { describe, expect, it } from 'vitest'

import { REVIEWED_BUILD_TTL_MS } from './reviewedBuild'
import { classifySendResponse, gateReviewed } from './sendSubmitOutcome'

describe('gateReviewed', () => {
  const now = 1_000_000_000

  it('lets a fresh review, and no review at all, through', () => {
    expect(gateReviewed({ builtAt: now - 1_000 }, now)).toBe('ok')
    expect(gateReviewed(null, now)).toBe('ok')
  })

  it('expires a review at the boundary', () => {
    expect(gateReviewed({ builtAt: now - REVIEWED_BUILD_TTL_MS }, now)).toBe('ok')
    expect(gateReviewed({ builtAt: now - REVIEWED_BUILD_TTL_MS - 1 }, now)).toBe('expired')
  })
})

describe('classifySendResponse', () => {
  it('treats both "nothing was signed" codes as review again', () => {
    expect(
      classifySendResponse({ ok: false, error: { message: 'x', code: 'network_fee_changed' } })
    ).toBe('review_again')
    expect(classifySendResponse({ ok: false, error: { message: 'x', code: 'review_again' } })).toBe(
      'review_again'
    )
  })

  it('treats other errors as failures and a good reply as success', () => {
    expect(
      classifySendResponse({ ok: false, error: { message: 'x', code: 'internal_error' } })
    ).toBe('failed')
    expect(classifySendResponse({ ok: false })).toBe('failed')
    expect(classifySendResponse({ ok: true })).toBe('success')
  })
})
