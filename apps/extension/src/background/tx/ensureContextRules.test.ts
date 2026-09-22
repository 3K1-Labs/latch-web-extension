import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SetupSendRulesRequest, StoredAccount } from '@latch/types'

const setupSendRules = vi.fn()
const setupSwapRules = vi.fn()

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
  setupSendRules: (...args: unknown[]) => setupSendRules(...args),
  setupSwapRules: (...args: unknown[]) => setupSwapRules(...args),
}))

vi.mock('../network/config', () => ({
  getActiveNetwork: vi.fn(async () => 'testnet' as const),
}))

vi.mock('./signBuiltTx', () => ({
  signAndSubmitBuiltTxInBackground: vi.fn(async () => ({ transactionHash: 'hash' })),
}))

import { BackendError } from '../backend'
import {
  __resetContextSetupInflightForTests,
  contextSetupKey,
  ensureSendRulesConfigured,
  ensureSwapRulesConfigured,
  withInflightContextSetup,
} from './ensureContextRules'

const ACCOUNT = {
  id: 'acc-1',
  mode: 'passkey',
  smartAccountAddress: 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY',
  passkeyKeyDataHex: 'ab12',
} as unknown as StoredAccount

const SEND_BODY: SetupSendRulesRequest = {
  smartAccountAddress: ACCOUNT.smartAccountAddress!,
  signerType: 'passkey',
  network: 'testnet',
  assetId: 'native',
}

describe('ensureSendRulesConfigured', () => {
  beforeEach(() => {
    setupSendRules.mockReset()
    __resetContextSetupInflightForTests()
  })

  it('reports already_configured without signing anything', async () => {
    setupSendRules.mockResolvedValue({ alreadyConfigured: true })
    const signAndSubmit = vi.fn()

    const result = await ensureSendRulesConfigured({
      setupBody: SEND_BODY,
      activeAccount: ACCOUNT,
      signAndSubmit,
    })

    expect(result).toBe('already_configured')
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('signs each setup transaction while assets remain', async () => {
    setupSendRules
      .mockResolvedValueOnce({ txXdr: 'one', remainingSetupCount: 1 })
      .mockResolvedValueOnce({ txXdr: 'two', remainingSetupCount: 0 })
    const signAndSubmit = vi.fn(async () => ({}) as never)

    const result = await ensureSendRulesConfigured({
      setupBody: SEND_BODY,
      activeAccount: ACCOUNT,
      signAndSubmit,
    })

    expect(result).toBe('configured')
    expect(signAndSubmit).toHaveBeenCalledTimes(2)
  })

  it('gives up after the attempt cap instead of looping forever', async () => {
    setupSendRules.mockResolvedValue({ txXdr: 'x', remainingSetupCount: 3 })

    await expect(
      ensureSendRulesConfigured({
        setupBody: SEND_BODY,
        activeAccount: ACCOUNT,
        signAndSubmit: vi.fn(async () => ({}) as never),
      })
    ).rejects.toThrow('Send setup did not complete')
    expect(setupSendRules).toHaveBeenCalledTimes(5)
  })
})

describe('ensureSwapRulesConfigured', () => {
  beforeEach(() => {
    setupSwapRules.mockReset()
    __resetContextSetupInflightForTests()
  })

  it('treats signer_already_exists as already configured', async () => {
    setupSwapRules.mockRejectedValue(
      new BackendError('duplicate', { code: 'signer_already_exists', status: 409 })
    )

    const result = await ensureSwapRulesConfigured({
      setupBody: { ...SEND_BODY, providerId: 'soroswap' },
      activeAccount: ACCOUNT,
      signAndSubmit: vi.fn(async () => ({}) as never),
    })

    expect(result).toBe('already_configured')
  })

  it('propagates other setup failures', async () => {
    setupSwapRules.mockRejectedValue(new BackendError('boom', { code: 'internal_error' }))

    await expect(
      ensureSwapRulesConfigured({
        setupBody: { ...SEND_BODY, providerId: 'soroswap' },
        activeAccount: ACCOUNT,
        signAndSubmit: vi.fn(async () => ({}) as never),
      })
    ).rejects.toThrow('boom')
  })
})

describe('withInflightContextSetup', () => {
  beforeEach(() => {
    __resetContextSetupInflightForTests()
  })

  it('coalesces concurrent setup for the same key', async () => {
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 'configured' as const
    })
    const key = contextSetupKey({
      network: 'testnet',
      smartAccountAddress: ACCOUNT.smartAccountAddress!,
      kind: 'send',
      target: 'native',
    })

    const [a, b] = await Promise.all([
      withInflightContextSetup(key, run),
      withInflightContextSetup(key, run),
    ])

    expect(run).toHaveBeenCalledTimes(1)
    expect([a, b]).toEqual(['configured', 'configured'])
  })

  it('does not share setup across different accounts or assets', async () => {
    const run = vi.fn(async () => 'configured' as const)
    const base = {
      network: 'testnet',
      smartAccountAddress: ACCOUNT.smartAccountAddress!,
      kind: 'send' as const,
    }

    await Promise.all([
      withInflightContextSetup(contextSetupKey({ ...base, target: 'native' }), run),
      withInflightContextSetup(contextSetupKey({ ...base, target: 'USDC' }), run),
    ])

    expect(run).toHaveBeenCalledTimes(2)
  })

  it('releases the key so a later request can retry after failure', async () => {
    const key = contextSetupKey({
      network: 'testnet',
      smartAccountAddress: ACCOUNT.smartAccountAddress!,
      kind: 'send',
      target: 'native',
    })

    await expect(
      withInflightContextSetup(key, async () => {
        throw new Error('setup failed')
      })
    ).rejects.toThrow('setup failed')

    await expect(withInflightContextSetup(key, async () => 'configured' as const)).resolves.toBe(
      'configured'
    )
  })
})
