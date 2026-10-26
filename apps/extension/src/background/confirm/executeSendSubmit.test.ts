import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BuildSendTxResponse, NetworkFee, StoredAccount } from '@latch/types'

const buildSendTx = vi.fn()
const signAndSubmit = vi.fn()
const ensureSendRulesConfigured = vi.fn()

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
  buildSendTx: (...args: unknown[]) => buildSendTx(...args),
}))
vi.mock('../network/config', () => ({ getActiveNetwork: vi.fn(async () => 'testnet' as const) }))
vi.mock('../storage', () => ({ getAccounts: vi.fn(async () => ({ accounts: [ACCOUNT] })) }))
vi.mock('../tx/ensureContextRules', async (importActual) => ({
  ...(await importActual<typeof import('../tx/ensureContextRules')>()),
  ensureSendRulesConfigured: (...args: unknown[]) => ensureSendRulesConfigured(...args),
}))
vi.mock('../tx/signBuiltTx', () => ({
  signAndSubmitBuiltTxInBackground: (...args: unknown[]) => signAndSubmit(...args),
}))
vi.mock('../../ui/lib/sendTx', async (importActual) => ({
  ...(await importActual<typeof import('../../ui/lib/sendTx')>()),
  buildSendRequestFromDraft: vi.fn(() => ({ network: 'testnet' })),
  buildSetupRequestFromDraft: vi.fn(() => ({ network: 'testnet' })),
}))

import { BackendError } from '../backend'
import { createChromeMock } from '../../test/chromeMock'
import { REVIEWED_BUILD_TTL_MS } from '../../ui/lib/reviewedBuild'
import type { SendDraft } from '../../ui/types/send'
import { __resetContextSetupInflightForTests } from '../tx/ensureContextRules'
import { executeSendSubmitInBackground, setupSendRulesForAccount } from './executeSendSubmit'
import { saveReviewedBuild } from './reviewedBuildStore'

const ACCOUNT = { id: 'acc-1', mode: 'passkey' } as unknown as StoredAccount
const DRAFT = { token: null, recipientAddress: 'C1', amount: '1', inputMode: 'crypto' } as SendDraft

const fee = (maxAmountRaw: string): NetworkFee => ({
  token: 'CXLM',
  symbol: 'XLM',
  maxAmountRaw,
  maxAmount: '0',
})
const build = (maxAmountRaw?: string, id = 'b'): BuildSendTxResponse =>
  ({ txXdr: id, ...(maxAmountRaw ? { networkFee: fee(maxAmountRaw) } : {}) }) as BuildSendTxResponse

const base = {
  accountId: 'acc-1',
  draft: DRAFT,
  sendTokenPriceUsd: null,
  network: 'testnet' as const,
}

const BODY = { network: 'testnet' }

describe('executeSendSubmitInBackground', () => {
  beforeEach(() => {
    globalThis.chrome = createChromeMock() as unknown as typeof chrome
    buildSendTx.mockReset()
    signAndSubmit.mockReset().mockResolvedValue({ transactionHash: 'hash' })
    ensureSendRulesConfigured.mockReset().mockResolvedValue('configured')
    __resetContextSetupInflightForTests()
  })

  it('signs the build the background holds, without rebuilding, even if a rebuild would cost more', async () => {
    const reviewed = build('140000', 'reviewed')
    await saveReviewedBuild('send', BODY, reviewed)
    buildSendTx.mockResolvedValue(build('140001', 'fresh'))

    const out = await executeSendSubmitInBackground({
      ...base,
      shownNetworkFee: fee('140000'),
      reviewed: true,
    })

    expect(buildSendTx).not.toHaveBeenCalled()
    expect(signAndSubmit).toHaveBeenCalledWith({ build: reviewed, activeAccount: ACCOUNT })
    expect(out.hash).toBe('hash')
  })

  it('refuses when no build is held for this draft (never signs a popup-made build)', async () => {
    await saveReviewedBuild('send', { network: 'testnet', recipient: 'OTHER' }, build('1'))

    await expect(
      executeSendSubmitInBackground({ ...base, shownNetworkFee: fee('1'), reviewed: true })
    ).rejects.toMatchObject({ code: 'review_again' })
    expect(buildSendTx).not.toHaveBeenCalled()
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('refuses an expired held build and signs nothing', async () => {
    await saveReviewedBuild('send', BODY, build('1'), Date.now() - REVIEWED_BUILD_TTL_MS - 1)

    await expect(
      executeSendSubmitInBackground({ ...base, shownNetworkFee: fee('1'), reviewed: true })
    ).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('refuses a held build priced differently from the fee the user saw', async () => {
    await saveReviewedBuild('send', BODY, build('200000'))

    await expect(
      executeSendSubmitInBackground({ ...base, shownNetworkFee: fee('140000'), reviewed: true })
    ).rejects.toMatchObject({ code: 'network_fee_changed' })
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('signs a held build once: a second Confirm needs a new review', async () => {
    await saveReviewedBuild('send', BODY, build('140000'))
    await executeSendSubmitInBackground({ ...base, shownNetworkFee: fee('140000'), reviewed: true })

    await expect(
      executeSendSubmitInBackground({ ...base, shownNetworkFee: fee('140000'), reviewed: true })
    ).rejects.toMatchObject({ code: 'review_again' })
    expect(signAndSubmit).toHaveBeenCalledTimes(1)
  })

  it('sends the user back to the summary when signing finds the rules gone', async () => {
    await saveReviewedBuild('send', BODY, build('140000'))
    signAndSubmit.mockRejectedValue(
      new BackendError('no rule', { status: 409, code: 'NO_CONTEXT_RULE' })
    )

    await expect(
      executeSendSubmitInBackground({ ...base, shownNetworkFee: fee('140000'), reviewed: true })
    ).rejects.toMatchObject({ code: 'review_again' })
  })

  it('without a review, a setup rebuild that shows a new fee is refused, not signed', async () => {
    buildSendTx
      .mockRejectedValueOnce(new BackendError('no rule', { status: 409, code: 'NO_CONTEXT_RULE' }))
      .mockResolvedValueOnce(build('140000'))

    await expect(
      executeSendSubmitInBackground({ ...base, shownNetworkFee: null })
    ).rejects.toMatchObject({ code: 'network_fee_changed' })
    expect(ensureSendRulesConfigured).toHaveBeenCalledTimes(1)
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('without a review, signs a rebuild the shown fee covers', async () => {
    const fresh = build('140000', 'fresh')
    buildSendTx.mockResolvedValue(fresh)

    await executeSendSubmitInBackground({ ...base, shownNetworkFee: fee('140000') })

    expect(signAndSubmit).toHaveBeenCalledWith({ build: fresh, activeAccount: ACCOUNT })
  })

  it('does not treat a review-again error as a missing-setup error', async () => {
    buildSendTx.mockRejectedValue(new BackendError('stale', { status: 409, code: 'review_again' }))

    await expect(executeSendSubmitInBackground({ ...base })).rejects.toMatchObject({
      code: 'review_again',
    })
    expect(ensureSendRulesConfigured).not.toHaveBeenCalled()
  })

  it('does not treat a fee-changed error as a missing-setup error', async () => {
    buildSendTx.mockRejectedValue(
      new BackendError('changed', { status: 409, code: 'network_fee_changed' })
    )

    await expect(executeSendSubmitInBackground({ ...base })).rejects.toMatchObject({
      code: 'network_fee_changed',
    })
    expect(ensureSendRulesConfigured).not.toHaveBeenCalled()
  })

  describe('setupSendRulesForAccount', () => {
    it('runs one setup for concurrent calls, and again once it has finished', async () => {
      let release!: (v: 'configured') => void
      ensureSendRulesConfigured.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        })
      )

      const a = setupSendRulesForAccount(ACCOUNT, DRAFT, 'testnet')
      const b = setupSendRulesForAccount(ACCOUNT, DRAFT, 'testnet')
      release('configured')

      expect(await Promise.all([a, b])).toEqual(['configured', 'configured'])
      expect(ensureSendRulesConfigured).toHaveBeenCalledTimes(1)

      await setupSendRulesForAccount(ACCOUNT, DRAFT, 'testnet')
      expect(ensureSendRulesConfigured).toHaveBeenCalledTimes(2)
    })

    it('clears the in-flight entry when setup fails so a retry can run', async () => {
      ensureSendRulesConfigured.mockRejectedValueOnce(new Error('dismissed'))
      await expect(setupSendRulesForAccount(ACCOUNT, DRAFT, 'testnet')).rejects.toThrow('dismissed')

      await expect(setupSendRulesForAccount(ACCOUNT, DRAFT, 'testnet')).resolves.toBe('configured')
      expect(ensureSendRulesConfigured).toHaveBeenCalledTimes(2)
    })
  })
})
