import { describe, expect, it, vi } from 'vitest'

import { friendlyError } from './backgroundClient'
import type { NetworkFee } from '@latch/types'

import {
  FEE_PROBE_AMOUNT,
  NETWORK_FEE_CHANGED_CODE,
  NETWORK_FEE_CHANGED_MESSAGE,
  REVIEW_AGAIN_CODE,
  isReviewAgainCode,
  USER_PAID_FEE_ERROR_CODES,
  fitMaxSendAmount,
  formatNetworkFeeLine,
  formatPreparedNetworkFeeLine,
  isUserPaidFeeErrorCode,
  maxSendAmountAfterFee,
  maxSendAmountFromProbe,
  networkFeeChanged,
  networkFeeEquals,
  userPaidFeeErrorMessage,
} from './networkFee'
import { isBuildSendMissingSetupError, isPrepareSignMissingSetupError } from './sendTx'

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

describe('formatPreparedNetworkFeeLine', () => {
  it('prefers the signed maximum over the estimated-XLM fallback', () => {
    expect(
      formatPreparedNetworkFeeLine({
        networkFee: {
          token: 'CAS3J7',
          symbol: 'XLM',
          maxAmountRaw: '140000',
          maxAmount: '0.014',
        },
        estimatedFeeXlm: '0.001',
        feeLabel: 'Fast',
      })
    ).toBe('up to 0.014 XLM')
  })

  it('falls back to the estimated-XLM label when networkFee is missing', () => {
    expect(formatPreparedNetworkFeeLine({ feeLabel: 'Fast', estimatedFeeXlm: '0.001' })).toBe(
      'Fast'
    )
    expect(formatPreparedNetworkFeeLine({ estimatedFeeXlm: '0.001' })).toBe('~ 0.001 Stellar')
    expect(formatPreparedNetworkFeeLine({})).toBeNull()
  })
})

const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

function fee(token: string, maxAmountRaw: string, symbol = 'XLM'): NetworkFee {
  return { token, symbol, maxAmountRaw, maxAmount: '' }
}

describe('maxSendAmountAfterFee', () => {
  it('subtracts the max fee when the token being sent pays the fee', () => {
    expect(
      maxSendAmountAfterFee(
        { sacContractId: XLM_SAC, amount: '10', decimals: 7 },
        fee(XLM_SAC, '140000')
      )
    ).toBe('9.986')
  })

  it('keeps 7-decimal precision', () => {
    expect(
      maxSendAmountAfterFee({ sacContractId: XLM_SAC, amount: '1.2345678' }, fee(XLM_SAC, '1'))
    ).toBe('1.2345677')
  })

  it('clamps at 0 when the fee exceeds the balance', () => {
    expect(
      maxSendAmountAfterFee({ sacContractId: XLM_SAC, amount: '0.01' }, fee(XLM_SAC, '140000'))
    ).toBe('0')
  })

  it('sends the full balance when the fee is paid in another token', () => {
    expect(
      maxSendAmountAfterFee({ sacContractId: USDC_SAC, amount: '25.5' }, fee(XLM_SAC, '140000'))
    ).toBe('25.5')
  })

  it('subtracts a USDC fee from a USDC max send', () => {
    expect(
      maxSendAmountAfterFee(
        { sacContractId: USDC_SAC, amount: '25.5' },
        fee(USDC_SAC, '50000', 'USDC')
      )
    ).toBe('25.495')
  })

  it('matches the fee token by contract, never by symbol', () => {
    const spoofed = 'CBGTG7XFRY3L6OKAUTR6KGDKUXUQBX3YDJ3QFDYTGVMOM7VV4O7NYO4X'
    expect(
      maxSendAmountAfterFee(
        { sacContractId: spoofed, amount: '10' },
        fee(USDC_SAC, '50000', 'USDC')
      )
    ).toBe('10')
  })

  it('sends the full balance without a known fee', () => {
    expect(maxSendAmountAfterFee({ sacContractId: XLM_SAC, amount: '10' }, undefined)).toBe('10')
  })
})

describe('maxSendAmountFromProbe', () => {
  const xlm = { sacContractId: XLM_SAC, amount: '10', decimals: 7 }

  it('subtracts the fee from a successful probe', () => {
    expect(maxSendAmountFromProbe(xlm, { ok: true, networkFee: fee(XLM_SAC, '140000') })).toBe(
      '9.986'
    )
  })

  it('returns 0 when the balance cannot cover the fee', () => {
    expect(maxSendAmountFromProbe(xlm, { ok: false, code: 'insufficient_fee_balance' })).toBe('0')
  })

  it('returns null for transient user-paid fee errors so the typed amount stays', () => {
    for (const code of [
      'service_unavailable',
      'too_many_failed_transactions',
      'sponsorship_limit_reached',
      'fee_rule_not_found',
    ]) {
      expect(maxSendAmountFromProbe(xlm, { ok: false, code })).toBeNull()
    }
  })

  it('returns null for other probe failures so the typed amount stays', () => {
    expect(maxSendAmountFromProbe(xlm, { ok: false, code: 'internal_error' })).toBeNull()
    expect(maxSendAmountFromProbe(xlm, { ok: false })).toBeNull()
  })
})

describe('networkFeeChanged', () => {
  it('is unchanged when neither build charges a user-paid fee', () => {
    expect(networkFeeChanged(null, undefined)).toBe(false)
  })

  it('is unchanged when the signed max is equal or lower in the same token', () => {
    expect(networkFeeChanged(fee(XLM_SAC, '140000'), fee(XLM_SAC, '140000'))).toBe(false)
    expect(networkFeeChanged(fee(XLM_SAC, '140000'), fee(XLM_SAC, '90000'))).toBe(false)
  })

  it('changes when the max goes up', () => {
    expect(networkFeeChanged(fee(XLM_SAC, '140000'), fee(XLM_SAC, '200000'))).toBe(true)
  })

  it('changes when the fee token switches', () => {
    expect(networkFeeChanged(fee(XLM_SAC, '140000'), fee(USDC_SAC, '10', 'USDC'))).toBe(true)
  })

  it('changes when a fee appears that was never shown', () => {
    expect(networkFeeChanged(null, fee(XLM_SAC, '140000'))).toBe(true)
  })
})

describe('user-paid fee errors', () => {
  // latch-api master internal/webappx/errors.go: the codes its gasless and user-paid fee paths
  // send (internal/handler/webapp/gasless_errors.go). Update both together.
  const LATCH_API_FEE_CODES = [
    'insufficient_fee_balance',
    'fee_quote_stale',
    'fee_rule_not_found',
    'too_many_failed_transactions',
    'sponsorship_limit_reached',
    'service_unavailable',
  ]

  it('handles exactly the codes latch-api sends', () => {
    expect([...USER_PAID_FEE_ERROR_CODES].sort()).toEqual([...LATCH_API_FEE_CODES].sort())
  })

  it('maps every latch-api code through friendlyError', () => {
    for (const code of LATCH_API_FEE_CODES) {
      expect(isUserPaidFeeErrorCode(code)).toBe(true)
      const message = userPaidFeeErrorMessage(code)
      expect(message).toBeTruthy()
      expect(friendlyError({ code, message: 'raw server text' })).toBe(message)
    }
    expect(friendlyError({ code: 'insufficient_fee_balance', message: 'x' })).toBe(
      'Add XLM or USDC to pay the network fee.'
    )
    expect(friendlyError({ code: 'service_unavailable', message: 'x' })).toBe(
      'The transaction service is temporarily unavailable. Please retry.'
    )
  })

  it('does not treat unsent codes as fee errors', () => {
    for (const code of ['sponsorship_retry', 'toString', undefined]) {
      expect(isUserPaidFeeErrorCode(code)).toBe(false)
      expect(userPaidFeeErrorMessage(code)).toBeNull()
    }
  })

  it('never treats fee errors as missing send or swap rules', () => {
    for (const code of LATCH_API_FEE_CODES) {
      expect(isBuildSendMissingSetupError({ status: 400, code })).toBe(false)
      expect(isPrepareSignMissingSetupError({ status: 400, code })).toBe(false)
    }
    expect(isBuildSendMissingSetupError({ status: 400, code: 'internal_error' })).toBe(true)
  })

  it('maps the fee-changed refusal to review copy', () => {
    expect(friendlyError({ code: NETWORK_FEE_CHANGED_CODE, message: 'x' })).toBe(
      NETWORK_FEE_CHANGED_MESSAGE
    )
  })

  it('never runs send-rule setup for a missing fee rule', () => {
    // 400 fee_rule_not_found needs the Default rule; setup-send-rules cannot fix it.
    expect(
      isBuildSendMissingSetupError({
        status: 400,
        code: 'fee_rule_not_found',
        message: "this signer can't authorize the network fee payment for this wallet",
      })
    ).toBe(false)
  })
})

describe('fitMaxSendAmount', () => {
  const xlm = { sacContractId: XLM_SAC, amount: '10', decimals: 7 }
  const ok = (maxAmountRaw: string) => ({
    ok: true as const,
    networkFee: fee(XLM_SAC, maxAmountRaw),
  })

  it('keeps the first amount when the real build prices the same fee', async () => {
    const probeAt = vi.fn().mockResolvedValue(ok('140000'))
    expect(await fitMaxSendAmount(xlm, probeAt)).toBe('9.986')
    expect(probeAt.mock.calls.map((c) => c[0])).toEqual([FEE_PROBE_AMOUNT, '9.986'])
  })

  it('shrinks the amount when the real build prices a higher fee, and verifies it', async () => {
    const probeAt = vi
      .fn()
      .mockResolvedValueOnce(ok('140000'))
      .mockResolvedValueOnce(ok('200000'))
      .mockResolvedValueOnce(ok('200000'))
    expect(await fitMaxSendAmount(xlm, probeAt)).toBe('9.98')
    expect(probeAt).toHaveBeenCalledTimes(3)
  })

  it('leaves double-fee headroom when the real build reports insufficient fee balance', async () => {
    const probeAt = vi
      .fn()
      .mockResolvedValueOnce(ok('140000'))
      .mockResolvedValueOnce({ ok: false, code: 'insufficient_fee_balance' })
      .mockResolvedValueOnce(ok('200000'))
    expect(await fitMaxSendAmount(xlm, probeAt)).toBe('9.972')
  })

  it('does not reduce a token that does not pay its own fee', async () => {
    const usdc = { sacContractId: 'CUSDC', amount: '5', decimals: 7 }
    const probeAt = vi.fn().mockResolvedValue(ok('140000'))
    expect(await fitMaxSendAmount(usdc, probeAt)).toBe('5')
    expect(probeAt).toHaveBeenCalledTimes(1)
  })

  it('returns 0 only for insufficient balance and null for transient failures', async () => {
    expect(
      await fitMaxSendAmount(xlm, async () => ({ ok: false, code: 'insufficient_fee_balance' }))
    ).toBe('0')
    expect(
      await fitMaxSendAmount(xlm, async () => ({ ok: false, code: 'service_unavailable' }))
    ).toBeNull()
  })
})

describe('networkFeeEquals', () => {
  it('treats two missing fees as equal', () => {
    expect(networkFeeEquals(null, undefined)).toBe(true)
  })

  it('needs the same token and cap', () => {
    expect(networkFeeEquals(fee(XLM_SAC, '140000'), fee(XLM_SAC, '140000'))).toBe(true)
    expect(networkFeeEquals(fee(XLM_SAC, '140000'), fee(XLM_SAC, '140001'))).toBe(false)
    expect(networkFeeEquals(fee(XLM_SAC, '140000'), fee('CUSDC', '140000'))).toBe(false)
  })

  it('is unequal when only one side charges a fee', () => {
    expect(networkFeeEquals(null, fee(XLM_SAC, '1'))).toBe(false)
    expect(networkFeeEquals(fee(XLM_SAC, '1'), undefined)).toBe(false)
  })
})

describe('isReviewAgainCode', () => {
  it('covers a changed fee and every other "nothing was signed" refusal', () => {
    expect(isReviewAgainCode(NETWORK_FEE_CHANGED_CODE)).toBe(true)
    expect(isReviewAgainCode(REVIEW_AGAIN_CODE)).toBe(true)
    expect(isReviewAgainCode('service_unavailable')).toBe(false)
    expect(isReviewAgainCode(undefined)).toBe(false)
  })
})
