import { describe, expect, it } from 'vitest'

import { swapQuotePayloadToVm } from './swapVm'

const payload = {
  providerId: 'aquarius',
  providerName: 'Aquarius',
  amountInRaw: '10000000',
  amountOutRaw: '3000000',
  amountOutMinRaw: '2900000',
  pathLabels: [],
  expiresAtMs: Date.now() + 60_000,
  slippageBps: 50,
  assetIn: {
    id: 'native',
    symbol: 'XLM',
    name: 'XLM',
    assetId: 'native',
    contractId: 'C',
    decimals: 7,
    balance: '10',
  },
  assetOut: {
    id: 'usdc',
    symbol: 'USDC',
    name: 'USDC',
    assetId: 'USDC',
    contractId: 'D',
    decimals: 7,
    balance: '0',
  },
  buildPayload: {},
}

describe('swapQuotePayloadToVm', () => {
  it('uses a placeholder fee until prepare returns networkFee', () => {
    expect(swapQuotePayloadToVm(payload).networkFeeLine).toBe('~ — Stellar')
  })

  it('formats the signed maximum when prepare returns networkFee', () => {
    expect(
      swapQuotePayloadToVm(payload, null, null, {
        token: 'C',
        symbol: 'XLM',
        maxAmountRaw: '140000',
        maxAmount: '0.014',
      }).networkFeeLine
    ).toBe('up to 0.014 XLM')
  })
})
