import { describe, expect, it } from 'vitest'

import { friendlyError } from './backgroundClient'
import { formatNetworkFeeLine, isUserPaidFeeErrorCode, userPaidFeeErrorMessage } from './networkFee'
import { isBuildSendMissingSetupError } from './sendTx'

describe('formatNetworkFeeLine', () => {
  it('formats the maximum fee', () => {
    expect(
      formatNetworkFeeLine({
        token: 'CAS3J7',
        symbol: 'XLM',
        maxAmountRaw: '140000',
        maxAmount: '0.014',
      })
    ).toBe('up to 0.014 XLM')
  })

  it('returns null without a fee', () => {
    expect(formatNetworkFeeLine(undefined)).toBeNull()
    expect(
      formatNetworkFeeLine({ token: 'C', symbol: '', maxAmountRaw: '1', maxAmount: '0' })
    ).toBeNull()
  })
})

describe('user-paid fee errors', () => {
  const codes = [
    'insufficient_fee_balance',
    'fee_quote_stale',
    'fee_rule_not_found',
    'too_many_failed_transactions',
    'sponsorship_limit_reached',
    'service_unavailable',
  ]

  it('maps every code through friendlyError', () => {
    for (const code of codes) {
      expect(isUserPaidFeeErrorCode(code)).toBe(true)
      expect(friendlyError({ code, message: 'raw server text' })).toBe(
        userPaidFeeErrorMessage(code)
      )
    }
    expect(friendlyError({ code: 'insufficient_fee_balance', message: 'x' })).toBe(
      'Add XLM or USDC to pay the network fee.'
    )
  })

  it('never treats fee errors as missing send rules', () => {
    expect(isBuildSendMissingSetupError({ status: 400, code: 'insufficient_fee_balance' })).toBe(
      false
    )
    expect(isBuildSendMissingSetupError({ status: 400, code: 'fee_rule_not_found' })).toBe(false)
    expect(isBuildSendMissingSetupError({ status: 400, code: 'internal_error' })).toBe(true)
  })
})
