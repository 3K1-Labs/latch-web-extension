import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const prepareSign = vi.fn()
const setupSendRules = vi.fn()
const setupSwapRules = vi.fn()
const signAndSubmitBuiltTxInBackground = vi.fn()
const getAccounts = vi.fn()

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
  prepareSign: (...args: unknown[]) => prepareSign(...args),
  fetchSignPayload: vi.fn(),
  setupSendRules: (...args: unknown[]) => setupSendRules(...args),
  setupSwapRules: (...args: unknown[]) => setupSwapRules(...args),
}))

vi.mock('../tx/signBuiltTx', () => ({
  signAndSubmitBuiltTxInBackground: (...args: unknown[]) =>
    signAndSubmitBuiltTxInBackground(...args),
}))

vi.mock('../storage', () => ({
  getAccounts: () => getAccounts(),
}))

vi.mock('../network/config', () => ({
  getActiveNetwork: vi.fn(async () => 'testnet' as const),
  networkPassphraseFor: (network: 'testnet' | 'mainnet') =>
    network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
}))

vi.mock('./allowList', () => ({
  isOriginAllowedForSigning: vi.fn(async () => true),
}))

vi.mock('./callbackUrl', () => ({
  assertAllowedCallbackUrl: vi.fn(),
}))

vi.mock('../../ui/lib/latchEnv', () => ({
  webauthnVerifierAddressFromEnv: () => 'CVERIFIER123',
}))

import { BackendError } from '../backend'
import { __resetContextSetupInflightForTests } from '../tx/ensureContextRules'
import { prepareExternalSignSession, runExternalSignFlow } from './orchestrator'

const SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const NATIVE_SAC = Asset.native().contractId(Networks.TESTNET)

function sacTransferXdr(sacContractId = NATIVE_SAC): string {
  const source = new Account(Keypair.random().publicKey(), '1')
  const contract = new Contract(sacContractId)
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      contract.call(
        'transfer',
        new Address(SMART).toScVal(),
        new Address(Keypair.random().publicKey()).toScVal(),
        nativeToScVal(10n, { type: 'i128' })
      )
    )
    .setTimeout(30)
    .build()
    .toXDR()
}

function unknownInvokeXdr(): string {
  const source = new Account(Keypair.random().publicKey(), '1')
  const unknown = new Asset(
    'FOO',
    'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
  ).contractId(Networks.TESTNET)
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(unknown).call('mint', nativeToScVal(1, { type: 'u32' })))
    .setTimeout(30)
    .build()
    .toXDR()
}

function preparedFor(txXdr: string) {
  return {
    txXdr,
    authEntryXdr: 'auth',
    authDigestHex: 'deadbeef',
    contextRuleId: 1,
    validUntilLedger: 100,
    network: 'testnet' as const,
    smartAccountAddress: SMART,
  }
}

function noContextRuleError() {
  return new BackendError('Context rule required', { status: 409, code: 'NO_CONTEXT_RULE' })
}

function opaquePrepareError() {
  return new BackendError('failed to prepare transaction', {
    status: 400,
    code: 'internal_error',
  })
}

function sessionRequest(xdr: string) {
  return {
    source: 'sign-request-tab' as const,
    request: {
      network: 'testnet' as const,
      smartAccountAddress: SMART,
      unsignedTxXdr: xdr,
      origin: 'https://example.com',
      requestId: 'req-1',
    },
  }
}

describe('external sign context-rule recovery', () => {
  beforeEach(() => {
    prepareSign.mockReset()
    setupSendRules.mockReset()
    setupSwapRules.mockReset()
    signAndSubmitBuiltTxInBackground.mockReset()
    signAndSubmitBuiltTxInBackground.mockResolvedValue({ transactionHash: 'setup-hash' })
    getAccounts.mockReset()
    getAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'acc-1',
          mode: 'passkey',
          smartAccountAddress: SMART,
          passkeyKeyDataHex: 'ab12',
          passkeyCredentialId: 'cred-1',
          gAddress: Keypair.random().publicKey(),
        },
      ],
      activeAccountId: 'acc-1',
    })
    __resetContextSetupInflightForTests()
  })

  it('runs setup and retries prepare once, reaching review', async () => {
    const xdr = sacTransferXdr()
    prepareSign.mockRejectedValueOnce(noContextRuleError()).mockResolvedValueOnce(preparedFor(xdr))
    setupSendRules.mockResolvedValue({ txXdr: 'setup', remainingSetupCount: 0 })

    const session = await prepareExternalSignSession(sessionRequest(xdr))

    expect(setupSendRules).toHaveBeenCalledTimes(1)
    expect(setupSendRules.mock.calls[0]![0]).toMatchObject({
      assetId: 'native',
      network: 'testnet',
    })
    expect(signAndSubmitBuiltTxInBackground).toHaveBeenCalledTimes(1)
    expect(prepareSign).toHaveBeenCalledTimes(2)
    expect(session.localReview.confirmBlocked).toBe(false)
    expect(session.signRequest.requestId).toBe('req-1')
  })

  it('keeps the request fields identical across the retry', async () => {
    const xdr = sacTransferXdr()
    prepareSign.mockRejectedValueOnce(noContextRuleError()).mockResolvedValueOnce(preparedFor(xdr))
    setupSendRules.mockResolvedValue({ txXdr: 'setup', remainingSetupCount: 0 })

    await prepareExternalSignSession(sessionRequest(xdr))

    expect(prepareSign.mock.calls[0]![0]).toEqual(prepareSign.mock.calls[1]![0])
    expect(prepareSign.mock.calls[1]![0]).toMatchObject({
      network: 'testnet',
      smartAccountAddress: SMART,
      unsignedTxXdr: xdr,
      signerType: 'passkey',
    })
  })

  it('reaches review through runExternalSignFlow after recovery', async () => {
    const xdr = sacTransferXdr()
    prepareSign.mockRejectedValueOnce(noContextRuleError()).mockResolvedValueOnce(preparedFor(xdr))
    setupSendRules.mockResolvedValue({ txXdr: 'setup', remainingSetupCount: 0 })
    const enqueueReview = vi.fn(async () => {})

    const result = await runExternalSignFlow({
      source: 'sign-request-tab',
      request: sessionRequest(xdr).request,
      waitForDecision: async () => ({ approved: false }),
      enqueueReview,
    })

    expect(enqueueReview).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ origin: 'https://example.com' })
  })

  it('does not run setup when the first prepare succeeds', async () => {
    const xdr = sacTransferXdr()
    prepareSign.mockResolvedValue(preparedFor(xdr))

    await prepareExternalSignSession(sessionRequest(xdr))

    expect(setupSendRules).not.toHaveBeenCalled()
    expect(prepareSign).toHaveBeenCalledTimes(1)
  })

  it('rethrows the original error when an opaque 400 needed no setup', async () => {
    const xdr = sacTransferXdr()
    prepareSign.mockRejectedValue(opaquePrepareError())
    setupSendRules.mockResolvedValue({ alreadyConfigured: true })

    const result = await runExternalSignFlow({
      source: 'sign-request-tab',
      request: sessionRequest(xdr).request,
      waitForDecision: async () => ({ approved: false }),
      enqueueReview: async () => {},
    })

    expect(result).toMatchObject({
      status: 'error',
      code: 'internal_error',
      message: 'failed to prepare transaction',
    })
    expect(prepareSign).toHaveBeenCalledTimes(1)
  })

  it('still retries an exact NO_CONTEXT_RULE when setup reports already configured', async () => {
    const xdr = sacTransferXdr()
    prepareSign.mockRejectedValueOnce(noContextRuleError()).mockResolvedValueOnce(preparedFor(xdr))
    setupSendRules.mockResolvedValue({ alreadyConfigured: true })

    const session = await prepareExternalSignSession(sessionRequest(xdr))

    expect(signAndSubmitBuiltTxInBackground).not.toHaveBeenCalled()
    expect(prepareSign).toHaveBeenCalledTimes(2)
    expect(session.prepared.txXdr).toBe(xdr)
  })

  it('surfaces a stable code when setup itself fails', async () => {
    const xdr = sacTransferXdr()
    prepareSign.mockRejectedValue(noContextRuleError())
    setupSendRules.mockRejectedValue(new Error('bundler unavailable'))

    const result = await runExternalSignFlow({
      source: 'sign-request-tab',
      request: sessionRequest(xdr).request,
      waitForDecision: async () => ({ approved: false }),
      enqueueReview: async () => {},
    })

    expect(result).toMatchObject({ status: 'error', code: 'context_rule_setup_failed' })
    expect(prepareSign).toHaveBeenCalledTimes(1)
  })

  it('surfaces the second prepare failure when the retry also fails', async () => {
    const xdr = sacTransferXdr()
    prepareSign
      .mockRejectedValueOnce(noContextRuleError())
      .mockRejectedValueOnce(
        new BackendError('simulation failed', { status: 400, code: 'validation_error' })
      )
    setupSendRules.mockResolvedValue({ txXdr: 'setup', remainingSetupCount: 0 })

    const result = await runExternalSignFlow({
      source: 'sign-request-tab',
      request: sessionRequest(xdr).request,
      waitForDecision: async () => ({ approved: false }),
      enqueueReview: async () => {},
    })

    expect(result).toMatchObject({ status: 'error', code: 'validation_error' })
    expect(prepareSign).toHaveBeenCalledTimes(2)
  })

  it('fails closed without calling setup for an unsupported transaction', async () => {
    prepareSign.mockRejectedValue(noContextRuleError())

    const result = await runExternalSignFlow({
      source: 'sign-request-tab',
      request: sessionRequest(unknownInvokeXdr()).request,
      waitForDecision: async () => ({ approved: false }),
      enqueueReview: async () => {},
    })

    expect(result).toMatchObject({ status: 'error', code: 'context_rule_setup_unsupported' })
    expect(setupSendRules).not.toHaveBeenCalled()
    expect(setupSwapRules).not.toHaveBeenCalled()
  })

  it('leaves non-setup prepare failures untouched', async () => {
    prepareSign.mockRejectedValue(
      new BackendError('Latch API unreachable', { status: 502, code: 'network_error' })
    )

    const result = await runExternalSignFlow({
      source: 'sign-request-tab',
      request: sessionRequest(sacTransferXdr()).request,
      waitForDecision: async () => ({ approved: false }),
      enqueueReview: async () => {},
    })

    expect(result).toMatchObject({ status: 'error', code: 'network_error' })
    expect(setupSendRules).not.toHaveBeenCalled()
    expect(prepareSign).toHaveBeenCalledTimes(1)
  })

  it('runs setup once for concurrent requests on the same account and asset', async () => {
    const xdr = sacTransferXdr()
    prepareSign
      .mockRejectedValueOnce(noContextRuleError())
      .mockRejectedValueOnce(noContextRuleError())
      .mockResolvedValue(preparedFor(xdr))
    setupSendRules.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { txXdr: 'setup', remainingSetupCount: 0 }
    })

    await Promise.all([
      prepareExternalSignSession(sessionRequest(xdr)),
      prepareExternalSignSession(sessionRequest(xdr)),
    ])

    expect(setupSendRules).toHaveBeenCalledTimes(1)
    expect(signAndSubmitBuiltTxInBackground).toHaveBeenCalledTimes(1)
  })
})
