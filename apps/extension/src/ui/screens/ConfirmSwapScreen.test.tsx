// @vitest-environment jsdom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { SwapDraft, SwapQuoteVm, SwapTokenVm } from '../swap/swapVm'
import { ConfirmSwapScreen } from './ConfirmSwapScreen'

afterEach(() => {
  cleanup()
})

const token: SwapTokenVm = {
  id: 'native',
  symbol: 'XLM',
  name: 'Stellar Lumens',
  assetId: 'native',
  contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  decimals: 7,
  balance: '10',
}

const draft: SwapDraft = {
  payTokenId: 'native',
  receiveTokenId: 'usdc',
  payAmount: '1',
  useExchangeBalance: false,
  approved: true,
}

const quote: SwapQuoteVm = {
  provider: 'Aquarius',
  rateLine: '1 XLM ≈ 0.3 USDC',
  slippageLine: 'Auto | 0.5%',
  minReceivedLine: '0.29 USDC',
  networkFeeLine: 'up to 0.014 XLM',
  receiveAmount: 0.3,
  receiveUsdApprox: '≈ $0.30',
  receiveAmountLine: '+0.3 USDC',
  receiveUsdApproxLine: '≈ $0.30',
  quotePayload: {
    providerId: 'aquarius',
    providerName: 'Aquarius',
    amountInRaw: '10000000',
    amountOutRaw: '3000000',
    amountOutMinRaw: '2900000',
    pathLabels: [],
    expiresAtMs: Date.now() + 60_000,
    slippageBps: 50,
    assetIn: token,
    assetOut: { ...token, id: 'usdc', symbol: 'USDC', name: 'USDC', assetId: 'USDC' },
    buildPayload: {},
  },
}

describe('ConfirmSwapScreen', () => {
  it('shows the max network fee before confirm', () => {
    render(
      <ConfirmSwapScreen
        surface="popup"
        draft={draft}
        quote={quote}
        resolveSwapToken={(id) => (id === 'native' ? token : quote.quotePayload.assetOut)}
        receiveAddress="CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY"
        onBackOrCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText('Network Fee')).toBeTruthy()
    expect(screen.getByText('up to 0.014 XLM')).toBeTruthy()
  })

  it('disables confirm and shows a user-paid fee error', () => {
    render(
      <ConfirmSwapScreen
        surface="popup"
        draft={draft}
        quote={quote}
        resolveSwapToken={(id) => (id === 'native' ? token : quote.quotePayload.assetOut)}
        receiveAddress="CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY"
        confirmDisabled
        feeError="Add XLM or USDC to pay the network fee."
        onBackOrCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText('Add XLM or USDC to pay the network fee.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Confirm Swap' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('says an expired quote is refreshing', () => {
    render(
      <ConfirmSwapScreen
        surface="popup"
        draft={draft}
        quote={{
          ...quote,
          quotePayload: { ...quote.quotePayload, expiresAtMs: Date.now() - 1_000 },
        }}
        resolveSwapToken={(id) => (id === 'native' ? token : quote.quotePayload.assetOut)}
        receiveAddress="CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY"
        onBackOrCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText('Quote expired — refreshing price')).toBeTruthy()
  })

  it('disables confirm while the fee is still loading', () => {
    render(
      <ConfirmSwapScreen
        surface="popup"
        draft={draft}
        quote={quote}
        resolveSwapToken={(id) => (id === 'native' ? token : quote.quotePayload.assetOut)}
        receiveAddress="CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY"
        confirmDisabled
        onBackOrCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(
      (screen.getByRole('button', { name: 'Confirm Swap' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})
