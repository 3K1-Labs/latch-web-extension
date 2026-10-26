// @vitest-environment jsdom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { BuildSendTxResponse, SmartAccountBalanceRow } from '@latch/types'

import {
  SEND_SETUP_FAILED_CODE,
  type FetchSendFeeEstimate,
  type SendDraft,
  type SendFeeEstimate,
} from '../../types/send'
import { SendSummaryScreen } from './SendSummaryScreen'

afterEach(() => cleanup())

const draft: SendDraft = {
  token: { code: 'XLM', amount: '10' } as SmartAccountBalanceRow,
  recipientAddress: 'GABC',
  amount: '1',
  inputMode: 'crypto',
}

const BUILD = {
  txXdr: 'x',
  networkFee: { token: 'CXLM', symbol: 'XLM', maxAmountRaw: '140000', maxAmount: '0.014' },
} as unknown as BuildSendTxResponse

function renderSummary(estimate: SendFeeEstimate, onReviewedBuild = vi.fn()) {
  render(
    <SendSummaryScreen
      surface="popup"
      draft={draft}
      priceUsd={null}
      networkLabel="Testnet"
      sendProgressLabel={null}
      sendError={null}
      onBack={() => undefined}
      onSend={() => undefined}
      onFetchFeeEstimate={() => Promise.resolve(estimate)}
      onReviewedBuild={onReviewedBuild}
    />
  )
  return onReviewedBuild
}

describe('SendSummaryScreen confirm gating', () => {
  it('keeps Send disabled until the estimate resolves, then hands over the reviewed build', async () => {
    const onReviewedBuild = renderSummary({ ok: true, data: BUILD })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    expect(onReviewedBuild).toHaveBeenLastCalledWith(BUILD)
  })

  it('offers Try again (not Send) after a failed setup, and a good retry restores Send', async () => {
    const onSend = vi.fn()
    const onFetchFeeEstimate = vi
      .fn<() => Promise<SendFeeEstimate>>()
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'setup broke', code: SEND_SETUP_FAILED_CODE },
      })
      .mockResolvedValueOnce({ ok: true, data: BUILD })
    render(
      <SendSummaryScreen
        surface="popup"
        draft={draft}
        priceUsd={null}
        networkLabel="Testnet"
        sendProgressLabel={null}
        sendError={null}
        onBack={() => undefined}
        onSend={onSend}
        onFetchFeeEstimate={onFetchFeeEstimate}
        onReviewedBuild={vi.fn()}
      />
    )

    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByText(/setup broke/i)).toBeTruthy()
    expect((retry as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(retry)
    expect(onSend).not.toHaveBeenCalled()
    expect(onFetchFeeEstimate).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())
    expect(screen.queryByText(/setup broke/i)).toBeNull()
  })

  it('says the wallet is being set up while first-time setup runs', async () => {
    let finish!: (e: SendFeeEstimate) => void
    const onFetchFeeEstimate: FetchSendFeeEstimate = (opts) => {
      opts?.onSettingUp?.()
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    render(
      <SendSummaryScreen
        surface="popup"
        draft={draft}
        priceUsd={null}
        networkLabel="Testnet"
        sendProgressLabel={null}
        sendError={null}
        onBack={() => undefined}
        onSend={() => undefined}
        onFetchFeeEstimate={onFetchFeeEstimate}
        onReviewedBuild={vi.fn()}
      />
    )

    expect(screen.getByText(/Setting up your wallet/)).toBeTruthy()
    finish({ ok: true, data: BUILD })
    await waitFor(() => expect(screen.queryByText(/Setting up your wallet/)).toBeNull())
  })

  it('keeps Send disabled (no retry) for a user-paid fee error', async () => {
    renderSummary({
      ok: false,
      error: { message: 'add XLM', code: 'insufficient_fee_balance' },
    })
    await waitFor(() => expect(screen.getByText(/XLM/i)).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
