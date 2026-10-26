/**
 * The key the estimate/prepare handlers save a build under must be the key Confirm looks up.
 * These run the real handlers and the real executors against each other (backend, storage and
 * signing mocked), so a drift in either request shape shows up as a refused Confirm here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackgroundMessage, StoredAccount, SwapQuotePayload } from '@latch/types'

const buildSendTx = vi.fn()
const buildSwapTx = vi.fn()
const signAndSubmit = vi.fn()

vi.mock('../api/client', () => ({ BackendError: class BackendError extends Error {} }))
vi.mock('../backend', () => ({
  BackendError: class BackendError extends Error {
    code?: string
    status?: number
    constructor(message: string, opts?: { code?: string; status?: number }) {
      super(message)
      this.code = opts?.code
      this.status = opts?.status
    }
  },
  buildSendTx: (...a: unknown[]) => buildSendTx(...a),
  buildSwapTx: (...a: unknown[]) => buildSwapTx(...a),
  prepareSign: vi.fn(),
  setupSwapRules: vi.fn(),
  buildDelegatedTx: vi.fn(),
  buildTx: vi.fn(),
  setupSendRules: vi.fn(),
  submitTxDelegated: vi.fn(),
  submitTxWebauthn: vi.fn(),
}))
vi.mock('../delegatedLocalSign', () => ({ signDelegatedGAddressEntry: vi.fn() }))
vi.mock('../mnemonicSession', () => ({ getMnemonicKeypair: vi.fn() }))
vi.mock('../tx/enforcingSimProbe', () => ({
  maybeProbeDelegatedEnforcingSim: vi.fn(),
  maybeProbeWebauthnEnforcingSim: vi.fn(),
}))
vi.mock('../network/config', () => ({
  getActiveNetwork: vi.fn(async () => 'testnet' as const),
  networkPassphraseFor: vi.fn(() => 'Test SDF Network ; September 2015'),
  sorobanRpcUrlFor: vi.fn(() => 'http://rpc'),
}))
vi.mock('../storage', () => ({ getAccounts: vi.fn(async () => ({ accounts: [ACCOUNT] })) }))
vi.mock('../swap/catalog', () => ({
  findSwapToken: vi.fn(),
  loadPayTokens: vi.fn(),
  loadReceiveTokens: vi.fn(),
  preferredReceiveTokenIds: vi.fn(),
}))
vi.mock('../swap/quoteCache', () => ({ getOrCreateQuote: vi.fn(), quoteCacheKey: vi.fn() }))
vi.mock('../requestWaiter', () => ({ withCancellableWaiter: vi.fn() }))
vi.mock('../tx/ensureContextRules', () => ({
  ensureSendRulesConfigured: vi.fn(),
  ensureSwapRulesConfigured: vi.fn(),
}))
vi.mock('../tx/signBuiltTx', () => ({
  signAndSubmitBuiltTxInBackground: (...a: unknown[]) => signAndSubmit(...a),
}))
vi.mock('../../ui/lib/latchEnv', () => ({ webauthnVerifierAddressFromEnv: () => undefined }))

import { createChromeMock } from '../../test/chromeMock'
import { buildSendRequestFromDraft } from '../../ui/lib/sendTx'
import type { SendDraft } from '../../ui/types/send'
import { tryHandleSwapMessage } from '../swap/handlers'
import { tryHandleTxMessage } from '../tx/handlers'
import { executeSendSubmitInBackground } from './executeSendSubmit'
import { executeSwapConfirmInBackground } from './executeSwapConfirm'

const ACCOUNT = {
  id: 'acc-1',
  mode: 'passkey',
  smartAccountAddress: 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY',
  passkeyKeyDataHex: 'ab12',
  createdAt: 1,
} as unknown as StoredAccount

const FEE = { token: 'CXLM', symbol: 'XLM', maxAmountRaw: '140000', maxAmount: '0.014' }
const ok = ((data: unknown) => ({ ok: true, data })) as never

const DRAFT = {
  token: { code: 'XLM', amount: '10', decimals: 7, sacContractId: 'CXLM' },
  recipientAddress: 'GRECIPIENT',
  amount: '1',
  inputMode: 'crypto',
} as unknown as SendDraft

const QUOTE = {
  providerId: 'aquarius',
  amountInRaw: '10000000',
  amountOutMinRaw: '1',
  buildPayload: {
    kind: 'aquarius',
    swapChainXdr: 'chain',
    routerContractId: 'CROUTER',
    tokenInContractId: 'CTOKEN',
  },
} as unknown as SwapQuotePayload

describe('reviewed build round trip', () => {
  beforeEach(() => {
    globalThis.chrome = createChromeMock() as unknown as typeof chrome
    buildSendTx.mockReset()
    buildSwapTx.mockReset()
    signAndSubmit.mockReset().mockResolvedValue({ transactionHash: 'hash' })
  })

  it('send: Confirm signs the build the estimate produced for the same draft', async () => {
    const built = { txXdr: 'held', networkFee: FEE }
    buildSendTx.mockResolvedValue(built)
    const request = buildSendRequestFromDraft(DRAFT, ACCOUNT, null, 'testnet')!

    await tryHandleTxMessage(
      { type: 'BUILD_SEND_TX', payload: request } as unknown as BackgroundMessage,
      vi.fn(),
      ok
    )
    buildSendTx.mockClear()

    const out = await executeSendSubmitInBackground({
      accountId: 'acc-1',
      draft: DRAFT,
      sendTokenPriceUsd: null,
      network: 'testnet',
      shownNetworkFee: FEE,
      reviewed: true,
    })

    expect(out.hash).toBe('hash')
    expect(buildSendTx).not.toHaveBeenCalled()
    expect(signAndSubmit).toHaveBeenCalledWith({ build: built, activeAccount: ACCOUNT })
  })

  it('send: an edited draft is refused, not signed from the old build', async () => {
    buildSendTx.mockResolvedValue({ txXdr: 'held', networkFee: FEE })
    await tryHandleTxMessage(
      {
        type: 'BUILD_SEND_TX',
        payload: buildSendRequestFromDraft(DRAFT, ACCOUNT, null, 'testnet'),
      } as unknown as BackgroundMessage,
      vi.fn(),
      ok
    )

    await expect(
      executeSendSubmitInBackground({
        accountId: 'acc-1',
        draft: { ...DRAFT, recipientAddress: 'GSOMEONEELSE' },
        sendTokenPriceUsd: null,
        network: 'testnet',
        shownNetworkFee: FEE,
        reviewed: true,
      })
    ).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  async function estimate(draft: SendDraft, account: StoredAccount, price: number | null = null) {
    buildSendTx.mockResolvedValue({ txXdr: 'held', networkFee: FEE })
    await tryHandleTxMessage(
      {
        type: 'BUILD_SEND_TX',
        payload: buildSendRequestFromDraft(draft, account, price, 'testnet'),
      } as unknown as BackgroundMessage,
      vi.fn(),
      ok
    )
  }

  const confirm = (draft: SendDraft, price: number | null = null) =>
    executeSendSubmitInBackground({
      accountId: 'acc-1',
      draft,
      sendTokenPriceUsd: price,
      network: 'testnet',
      shownNetworkFee: FEE,
      reviewed: true,
    })

  it('send: a held build is signed once; a second Confirm needs a new review', async () => {
    await estimate(DRAFT, ACCOUNT)
    await confirm(DRAFT)

    await expect(confirm(DRAFT)).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).toHaveBeenCalledTimes(1)
  })

  it('send: a fiat price that moved between review and Confirm is refused', async () => {
    const fiat = { ...DRAFT, inputMode: 'fiat', amount: '10' } as SendDraft
    await estimate(fiat, ACCOUNT, 0.1)
    await expect(confirm(fiat, 0.2)).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('send: a request built from a different signer record is refused (documents drift)', async () => {
    const stale = { ...ACCOUNT, passkeyKeyDataHex: 'ffff' } as StoredAccount
    await estimate(DRAFT, stale)

    await expect(confirm(DRAFT)).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('swap: Confirm signs the prepare held for the same quote, and not for another', async () => {
    const prepared = { txXdr: 'held-swap', networkFee: FEE }
    buildSwapTx.mockResolvedValue(prepared)

    await tryHandleSwapMessage(
      {
        type: 'PREPARE_SWAP_TX',
        payload: { accountId: 'acc-1', quote: QUOTE },
      } as unknown as BackgroundMessage,
      vi.fn(),
      ok
    )

    await expect(
      executeSwapConfirmInBackground({
        accountId: 'acc-1',
        quote: { ...QUOTE, amountInRaw: '99' } as SwapQuotePayload,
        shownNetworkFee: FEE,
        reviewed: true,
      })
    ).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).not.toHaveBeenCalled()

    const out = await executeSwapConfirmInBackground({
      accountId: 'acc-1',
      quote: QUOTE,
      shownNetworkFee: FEE,
      reviewed: true,
    })
    expect(out.prepared).toEqual(prepared)
    expect(signAndSubmit).toHaveBeenCalledWith({ build: prepared, activeAccount: ACCOUNT })
  })
})
