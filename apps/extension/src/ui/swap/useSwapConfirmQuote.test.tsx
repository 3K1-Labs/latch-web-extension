// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type { PrepareSwapTxResponse, StoredAccount } from '@latch/types'

const sendToBackground = vi.fn()

vi.mock('../lib/backgroundClient', () => ({
  sendToBackground: (...args: unknown[]) => sendToBackground(...args),
  friendlyError: (e?: { message?: string }) => e?.message ?? '',
  logLatchError: vi.fn(),
}))
vi.mock('../../lib/walletOutcome', () => ({
  writePendingWalletOutcome: vi.fn(async () => undefined),
  clearPendingWalletOutcome: vi.fn(async () => undefined),
}))

import { REVIEWED_BUILD_TTL_MS } from '../lib/reviewedBuild'
import type { SwapDraft, SwapQuoteVm } from './swapVm'
import { useSwapConfirmQuote } from './useSwapConfirmQuote'

const ACCOUNT = { id: 'acc-1', mode: 'passkey' } as unknown as StoredAccount
const DRAFT = { payTokenId: 'native', receiveTokenId: 'usdc', payAmount: '1' } as SwapDraft

function makeQuote(): SwapQuoteVm {
  return {
    quotePayload: {
      providerId: 'aquarius',
      expiresAtMs: Date.now() + 10 * 60_000,
      amountInRaw: '10000000',
      assetIn: { decimals: 7 },
      slippageBps: 50,
    },
  } as unknown as SwapQuoteVm
}

const prepared = (id: string): PrepareSwapTxResponse =>
  ({
    txXdr: id,
    networkFee: { token: 'CXLM', symbol: 'XLM', maxAmountRaw: '140000', maxAmount: '0.014' },
  }) as unknown as PrepareSwapTxResponse

function setup() {
  return renderHook(() =>
    useSwapConfirmQuote({
      route: 'swapConfirm',
      surface: 'popup',
      activeAccount: ACCOUNT,
      draft: DRAFT,
      step: 'confirm',
      busy: false,
      resolveSwapToken: () => undefined,
      priceUsdBySymbol: {},
    })
  )
}

const messageTypes = () => sendToBackground.mock.calls.map((c) => c[0].type)

describe('useSwapConfirmQuote', () => {
  beforeEach(() => {
    sendToBackground.mockReset()
  })
  afterEach(() => cleanup())

  it('blocks Confirm until the prepare lands, then holds the reviewed prepare', async () => {
    sendToBackground.mockResolvedValue({ ok: true, data: prepared('p1') })
    const { result } = setup()
    act(() => result.current.setQuote(makeQuote()))

    await waitFor(() =>
      expect(result.current.reviewed?.networkFee).toEqual(prepared('p1').networkFee)
    )
    expect(result.current.loading).toBe(false)
    expect(result.current.confirmBlocked).toBe(false)
    expect(result.current.shownNetworkFee?.maxAmountRaw).toBe('140000')
    expect(messageTypes()).toEqual(['PREPARE_SWAP_TX'])
  })

  it('runs rule setup only when the build reports missing rules, then shows the rebuilt fee', async () => {
    sendToBackground
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'no rule', code: 'NO_CONTEXT_RULE', status: 409 },
      })
      .mockResolvedValueOnce({ ok: true, data: { result: 'configured' } })
      .mockResolvedValueOnce({ ok: true, data: prepared('after-setup') })
    const { result } = setup()
    act(() => result.current.setQuote(makeQuote()))

    expect(result.current.confirmBlocked).toBe(true)
    await waitFor(() =>
      expect(result.current.reviewed?.networkFee).toEqual(prepared('after-setup').networkFee)
    )
    expect(messageTypes()).toEqual(['PREPARE_SWAP_TX', 'RUN_SWAP_RULES_SETUP', 'PREPARE_SWAP_TX'])
    expect(result.current.confirmBlocked).toBe(false)
  })

  it('does not prepare twice when setup reports already_configured', async () => {
    sendToBackground
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'odd failure', code: 'NO_CONTEXT_RULE', status: 409 },
      })
      .mockResolvedValueOnce({ ok: true, data: { result: 'already_configured' } })
    const { result } = setup()
    act(() => result.current.setQuote(makeQuote()))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(messageTypes()).toEqual(['PREPARE_SWAP_TX', 'RUN_SWAP_RULES_SETUP'])
    expect(result.current.reviewed).toBeNull()
  })

  it('does not treat a build that still needs a signer reconfigure as reviewed', async () => {
    const bundlerOnly = { ...prepared('p'), submitMethod: 'bundler-delegated' }
    sendToBackground
      .mockResolvedValueOnce({ ok: true, data: bundlerOnly })
      .mockResolvedValueOnce({ ok: true, data: { result: 'configured' } })
      .mockResolvedValueOnce({ ok: true, data: bundlerOnly })
    const { result } = setup()
    act(() => result.current.setQuote(makeQuote()))

    await waitFor(() =>
      expect(result.current.error).toBe('Swap setup did not complete. Try again.')
    )
    expect(result.current.reviewed).toBeNull()
    expect(result.current.confirmBlocked).toBe(true)
    expect(messageTypes()).toEqual(['PREPARE_SWAP_TX', 'RUN_SWAP_RULES_SETUP', 'PREPARE_SWAP_TX'])
  })

  it('stops after one setup when setup is already_configured but the build still needs one', async () => {
    const bundlerOnly = { ...prepared('p'), submitMethod: 'bundler-delegated' }
    sendToBackground
      .mockResolvedValueOnce({ ok: true, data: bundlerOnly })
      .mockResolvedValueOnce({ ok: true, data: { result: 'already_configured' } })
    const { result } = setup()
    act(() => result.current.setQuote(makeQuote()))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.reviewed).toBeNull()
    expect(messageTypes()).toEqual(['PREPARE_SWAP_TX', 'RUN_SWAP_RULES_SETUP'])
  })

  it('keeps Confirm blocked and shows the error when setup fails', async () => {
    sendToBackground
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'no rule', code: 'NO_CONTEXT_RULE', status: 409 },
      })
      .mockResolvedValueOnce({ ok: false, error: { message: 'setup broke' } })
    const { result } = setup()
    act(() => result.current.setQuote(makeQuote()))

    await waitFor(() => expect(result.current.error).toBe('setup broke'))
    expect(result.current.reviewed).toBeNull()
    expect(result.current.confirmBlocked).toBe(true)
  })

  it('refuses to confirm an expired reviewed prepare and prepares again', async () => {
    sendToBackground.mockResolvedValue({ ok: true, data: prepared('p1') })
    const { result } = setup()
    act(() => result.current.setQuote(makeQuote()))
    await waitFor(() => expect(result.current.reviewed).not.toBeNull())
    expect(result.current.checkBeforeConfirm()).toBe(true)

    const realNow = Date.now()
    let allowed = true
    act(() => {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + REVIEWED_BUILD_TTL_MS + 1_000)
      allowed = result.current.checkBeforeConfirm()
      spy.mockRestore()
    })

    expect(allowed).toBe(false)
    expect(result.current.notice).toContain('expired')
    await waitFor(() =>
      expect(messageTypes().filter((t) => t === 'PREPARE_SWAP_TX')).toHaveLength(2)
    )
    // The quote itself was fine: no quote reload, only a new prepare.
    expect(messageTypes()).not.toContain('GET_SWAP_QUOTE')
  })

  it('reports a Confirm in flight so a second click is ignored', () => {
    const { result } = setup()
    expect(result.current.isSubmitting()).toBe(false)
    act(() => result.current.beginSubmit())
    expect(result.current.isSubmitting()).toBe(true)
    act(() => result.current.endSubmit())
    expect(result.current.isSubmitting()).toBe(false)
  })

  it('reviewAgain shows the message and prepares again', async () => {
    sendToBackground.mockResolvedValue({ ok: true, data: prepared('p1') })
    const { result } = setup()
    act(() => result.current.setQuote(makeQuote()))
    await waitFor(() => expect(result.current.reviewed).not.toBeNull())

    act(() => result.current.reviewAgain('The network fee changed.'))

    expect(result.current.notice).toBe('The network fee changed.')
    await waitFor(() =>
      expect(messageTypes().filter((t) => t === 'PREPARE_SWAP_TX')).toHaveLength(2)
    )
    await waitFor(() => expect(result.current.reviewed).not.toBeNull())
  })
})
