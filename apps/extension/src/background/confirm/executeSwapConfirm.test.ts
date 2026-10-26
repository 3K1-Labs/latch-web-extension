import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NetworkFee,
  PrepareSwapTxResponse,
  StoredAccount,
  SwapQuotePayload,
} from '@latch/types'

const runPrepareSwapTx = vi.fn()
const signAndSubmit = vi.fn()
const ensureSwapRulesConfigured = vi.fn()

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
}))
vi.mock('../network/config', () => ({ getActiveNetwork: vi.fn(async () => 'testnet' as const) }))
vi.mock('../storage', () => ({ getAccounts: vi.fn(async () => ({ accounts: [ACCOUNT] })) }))
vi.mock('../swap/handlers', () => ({
  runPrepareSwapTx: (...args: unknown[]) => runPrepareSwapTx(...args),
}))
vi.mock('../tx/ensureContextRules', async (importActual) => ({
  ...(await importActual<typeof import('../tx/ensureContextRules')>()),
  ensureSwapRulesConfigured: (...args: unknown[]) => ensureSwapRulesConfigured(...args),
}))
vi.mock('../tx/signBuiltTx', () => ({
  signAndSubmitBuiltTxInBackground: (...args: unknown[]) => signAndSubmit(...args),
}))
vi.mock('../../ui/lib/latchEnv', () => ({ webauthnVerifierAddressFromEnv: () => undefined }))

import { BackendError } from '../backend'
import { createChromeMock } from '../../test/chromeMock'
import { REVIEWED_BUILD_TTL_MS } from '../../ui/lib/reviewedBuild'
import { __resetContextSetupInflightForTests } from '../tx/ensureContextRules'
import { executeSwapConfirmInBackground, setupSwapRulesForAccount } from './executeSwapConfirm'
import { reviewedSwapBody, saveReviewedBuild } from './reviewedBuildStore'

const ACCOUNT = {
  id: 'acc-1',
  mode: 'passkey',
  smartAccountAddress: 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY',
  passkeyKeyDataHex: 'ab12',
} as unknown as StoredAccount
const QUOTE = { providerId: 'soroswap', buildPayload: {} } as unknown as SwapQuotePayload

const fee = (maxAmountRaw: string): NetworkFee => ({
  token: 'CXLM',
  symbol: 'XLM',
  maxAmountRaw,
  maxAmount: '0',
})
const prepared = (maxAmountRaw?: string, id = 'p'): PrepareSwapTxResponse =>
  ({
    txXdr: id,
    ...(maxAmountRaw ? { networkFee: fee(maxAmountRaw) } : {}),
  }) as PrepareSwapTxResponse

const base = { accountId: 'acc-1', quote: QUOTE }

const BODY = reviewedSwapBody('acc-1', QUOTE)

describe('executeSwapConfirmInBackground', () => {
  beforeEach(() => {
    globalThis.chrome = createChromeMock() as unknown as typeof chrome
    runPrepareSwapTx.mockReset()
    signAndSubmit.mockReset().mockResolvedValue({ transactionHash: 'hash' })
    ensureSwapRulesConfigured.mockReset().mockResolvedValue('configured')
    __resetContextSetupInflightForTests()
  })

  it('signs the prepare the background holds: no setup, no second prepare', async () => {
    const reviewed = prepared('140000', 'reviewed')
    await saveReviewedBuild('swap', BODY, reviewed)

    const out = await executeSwapConfirmInBackground({
      ...base,
      shownNetworkFee: fee('140000'),
      reviewed: true,
    })

    expect(runPrepareSwapTx).not.toHaveBeenCalled()
    expect(ensureSwapRulesConfigured).not.toHaveBeenCalled()
    expect(signAndSubmit).toHaveBeenCalledWith({ build: reviewed, activeAccount: ACCOUNT })
    expect(out.prepared).toEqual(reviewed)
  })

  it('refuses when no prepare is held for this quote', async () => {
    await saveReviewedBuild(
      'swap',
      reviewedSwapBody('acc-1', { ...QUOTE, amountInRaw: '9' }),
      prepared('1')
    )

    await expect(
      executeSwapConfirmInBackground({ ...base, shownNetworkFee: fee('1'), reviewed: true })
    ).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('refuses an expired held prepare and signs nothing', async () => {
    await saveReviewedBuild('swap', BODY, prepared('1'), Date.now() - REVIEWED_BUILD_TTL_MS - 1)

    await expect(
      executeSwapConfirmInBackground({ ...base, shownNetworkFee: fee('1'), reviewed: true })
    ).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('refuses a held prepare priced differently from the fee the user saw', async () => {
    await saveReviewedBuild('swap', BODY, prepared('200000'))

    await expect(
      executeSwapConfirmInBackground({ ...base, shownNetworkFee: fee('140000'), reviewed: true })
    ).rejects.toMatchObject({ code: 'network_fee_changed' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('sends the user back to confirm when signing finds the rules gone', async () => {
    await saveReviewedBuild('swap', BODY, prepared('140000'))
    signAndSubmit.mockRejectedValue(
      new BackendError('no rule', { status: 409, code: 'NO_CONTEXT_RULE' })
    )

    await expect(
      executeSwapConfirmInBackground({ ...base, shownNetworkFee: fee('140000'), reviewed: true })
    ).rejects.toMatchObject({ code: 'review_again' })
    expect(ensureSwapRulesConfigured).not.toHaveBeenCalled()
  })

  it('treats a generic 400 while signing a held build as a failure, not a setup signal', async () => {
    await saveReviewedBuild('swap', BODY, prepared('140000'))
    signAndSubmit.mockRejectedValue(
      new BackendError('failed to build', { status: 400, code: 'internal_error' })
    )

    await expect(
      executeSwapConfirmInBackground({ ...base, shownNetworkFee: fee('140000'), reviewed: true })
    ).rejects.toMatchObject({ code: 'internal_error' })
  })

  it('does not run setup on the happy path for Soroswap', async () => {
    runPrepareSwapTx.mockResolvedValue(prepared('140000'))

    await executeSwapConfirmInBackground({ ...base, shownNetworkFee: fee('140000') })

    expect(ensureSwapRulesConfigured).not.toHaveBeenCalled()
    expect(signAndSubmit).toHaveBeenCalledTimes(1)
  })

  it('refuses a rebuild whose fee the user never saw', async () => {
    runPrepareSwapTx.mockResolvedValue(prepared('140000'))

    await expect(
      executeSwapConfirmInBackground({ ...base, shownNetworkFee: null })
    ).rejects.toMatchObject({ code: 'network_fee_changed' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('does not send a review-again error through rule setup', async () => {
    runPrepareSwapTx.mockRejectedValue(
      new BackendError('stale', { status: 409, code: 'review_again' })
    )

    await expect(executeSwapConfirmInBackground({ ...base })).rejects.toMatchObject({
      code: 'review_again',
    })
    expect(ensureSwapRulesConfigured).not.toHaveBeenCalled()
  })

  it('does not send a fee-changed error through rule setup', async () => {
    runPrepareSwapTx.mockRejectedValue(
      new BackendError('changed', { status: 409, code: 'network_fee_changed' })
    )

    await expect(executeSwapConfirmInBackground({ ...base })).rejects.toMatchObject({
      code: 'network_fee_changed',
    })
    expect(ensureSwapRulesConfigured).not.toHaveBeenCalled()
  })

  describe('setupSwapRulesForAccount', () => {
    it('runs one setup for concurrent calls, and again once it has finished', async () => {
      let release!: (v: 'configured') => void
      ensureSwapRulesConfigured.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        })
      )

      const a = setupSwapRulesForAccount(ACCOUNT, QUOTE)
      const b = setupSwapRulesForAccount(ACCOUNT, QUOTE)
      await vi.waitFor(() => expect(ensureSwapRulesConfigured).toHaveBeenCalledTimes(1))
      release('configured')

      expect(await Promise.all([a, b])).toEqual(['configured', 'configured'])
      expect(ensureSwapRulesConfigured).toHaveBeenCalledTimes(1)

      await setupSwapRulesForAccount(ACCOUNT, QUOTE)
      expect(ensureSwapRulesConfigured).toHaveBeenCalledTimes(2)
    })
  })
})
