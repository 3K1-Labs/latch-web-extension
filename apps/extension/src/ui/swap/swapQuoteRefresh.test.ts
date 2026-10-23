import { describe, expect, it } from 'vitest'

import {
  QUOTE_CACHE_DEDUPE_MS,
  QUOTE_REFRESH_LEAD_MS,
  shouldApplySwapQuoteRefresh,
  swapConfirmBlocked,
  swapQuoteMatchesDraft,
  swapQuoteRefreshAction,
  swapQuoteRefreshWaitMs,
} from './swapQuoteRefresh'

const NOW = 1_000_000

function input(overrides: Partial<Parameters<typeof swapQuoteRefreshAction>[0]> = {}) {
  return {
    now: NOW,
    expiresAt: NOW + 120_000,
    providerId: 'aquarius',
    entryExpiresAt: null as number | null,
    attemptedAt: null as number | null,
    ...overrides,
  }
}

describe('swapQuoteRefreshAction', () => {
  it('refreshes a Soroswap quote once on entry', () => {
    const expiresAt = NOW + 120_000
    expect(swapQuoteRefreshAction(input({ providerId: 'soroswap', expiresAt }))).toBe('refresh')
    expect(
      swapQuoteRefreshAction(
        input({
          providerId: 'soroswap',
          expiresAt,
          entryExpiresAt: expiresAt,
          attemptedAt: NOW,
        })
      )
    ).toBe('wait')
  })

  it('does not refresh a later Soroswap quote until it is inside the lead', () => {
    expect(
      swapQuoteRefreshAction(
        input({
          providerId: 'soroswap',
          expiresAt: NOW + 120_000,
          entryExpiresAt: NOW + 30_000,
          attemptedAt: null,
        })
      )
    ).toBe('wait')
  })

  it('refreshes a quote inside the lead', () => {
    expect(swapQuoteRefreshAction(input({ expiresAt: NOW + QUOTE_REFRESH_LEAD_MS }))).toBe(
      'refresh'
    )
    expect(swapQuoteRefreshAction(input({ expiresAt: NOW - 1 }))).toBe('refresh')
  })

  it('does not refresh the same expiry again inside the cache window', () => {
    const expiresAt = NOW + 4_000
    expect(swapQuoteRefreshAction(input({ expiresAt, attemptedAt: NOW - 1_000 }))).toBe('wait')
  })

  it('refreshes the same expiry once the cache window has passed', () => {
    const expiresAt = NOW - 1_000
    expect(
      swapQuoteRefreshAction(input({ expiresAt, attemptedAt: NOW - QUOTE_CACHE_DEDUPE_MS }))
    ).toBe('refresh')
  })
})

describe('swapQuoteRefreshWaitMs', () => {
  it('waits until the lead window for a fresh quote', () => {
    expect(swapQuoteRefreshWaitMs(input({ expiresAt: NOW + 120_000 }))).toBe(
      120_000 - QUOTE_REFRESH_LEAD_MS
    )
  })

  it('wakes at expiry while a recent attempt is still inside the cache window', () => {
    expect(swapQuoteRefreshWaitMs(input({ expiresAt: NOW + 4_000, attemptedAt: NOW }))).toBe(4_000)
  })
})

describe('swapQuoteMatchesDraft', () => {
  it('matches the draft amount to the quote input', () => {
    expect(swapQuoteMatchesDraft('1', 7, '10000000')).toBe(true)
    expect(swapQuoteMatchesDraft('2', 7, '10000000')).toBe(false)
    expect(swapQuoteMatchesDraft('nope', 7, '10000000')).toBe(false)
  })
})

describe('shouldApplySwapQuoteRefresh', () => {
  it('applies a refresh that is still the current one and not submitting', () => {
    expect(shouldApplySwapQuoteRefresh({ requestGen: 2, currentGen: 2, submitting: false })).toBe(
      true
    )
  })

  it('drops a refresh from an older generation or one that arrives during submit', () => {
    expect(shouldApplySwapQuoteRefresh({ requestGen: 1, currentGen: 2, submitting: false })).toBe(
      false
    )
    expect(shouldApplySwapQuoteRefresh({ requestGen: 2, currentGen: 2, submitting: true })).toBe(
      false
    )
  })
})

describe('swapConfirmBlocked', () => {
  it('blocks an expired quote', () => {
    expect(
      swapConfirmBlocked({ remainingMs: -1, refreshing: false, feeLoading: false, feeError: false })
    ).toBe(true)
  })

  it('allows a quote that still has time', () => {
    expect(
      swapConfirmBlocked({
        remainingMs: 60_000,
        refreshing: false,
        feeLoading: false,
        feeError: false,
      })
    ).toBe(false)
  })
})
