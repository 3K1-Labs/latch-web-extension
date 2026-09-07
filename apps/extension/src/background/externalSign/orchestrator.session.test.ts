import {
  Account,
  Asset,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const prepareSign = vi.fn()
const getAccounts = vi.fn()
const getActiveNetwork = vi.fn(async () => 'testnet' as const)
const isOriginAllowedForSigning = vi.fn(async () => true)

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
}))

vi.mock('../storage', () => ({
  getAccounts: () => getAccounts(),
}))

vi.mock('../network/config', () => ({
  getActiveNetwork: () => getActiveNetwork(),
  networkPassphraseFor: (network: 'testnet' | 'mainnet') =>
    network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
}))

vi.mock('./allowList', () => ({
  isOriginAllowedForSigning: (...args: unknown[]) => isOriginAllowedForSigning(...args),
}))

vi.mock('./callbackUrl', () => ({
  assertAllowedCallbackUrl: vi.fn(),
}))

import { BackendError } from '../backend'
import { prepareExternalSignSession, runExternalSignFlow } from './orchestrator'

const SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function genericInvokeXdr(contractId: string, fn: string): string {
  const kp = Keypair.random()
  const account = new Account(kp.publicKey(), '1')
  const contract = new Contract(contractId)
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call(fn, nativeToScVal(1, { type: 'u32' })))
    .setTimeout(30)
    .build()
    .toXDR()
}

function mockPrepared(txXdr: string) {
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

describe('prepareExternalSignSession localReview', () => {
  beforeEach(() => {
    prepareSign.mockReset()
    getAccounts.mockReset()
    getActiveNetwork.mockReset()
    getActiveNetwork.mockResolvedValue('testnet')
    isOriginAllowedForSigning.mockResolvedValue(true)
    getAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'acc-1',
          mode: 'passkey',
          smartAccountAddress: SMART,
          gAddress: Keypair.random().publicKey(),
        },
      ],
      activeAccountId: 'acc-1',
    })
  })

  it('attaches localReview when unsigned and prepared invoke the same contract', async () => {
    const nativeId = Asset.native().contractId(Networks.TESTNET)
    const xdr = genericInvokeXdr(nativeId, 'swap')
    prepareSign.mockResolvedValue(mockPrepared(xdr))

    const session = await prepareExternalSignSession({
      source: 'sign-request-tab',
      request: {
        network: 'testnet',
        smartAccountAddress: SMART,
        unsignedTxXdr: xdr,
        origin: 'https://example.com',
      },
    })

    expect(session.localReview.confirmBlocked).toBe(false)
    expect(session.localReview.operations.length).toBeGreaterThan(0)
    expect(session.localReview.operations[0]?.summary).toContain('swap')
  })

  it('sets confirmBlocked on contract mismatch without throwing', async () => {
    const nativeId = Asset.native().contractId(Networks.TESTNET)
    const usdcId = new Asset('USDC', USDC_ISSUER).contractId(Networks.TESTNET)
    const unsigned = genericInvokeXdr(nativeId, 'swap')
    const prepared = genericInvokeXdr(usdcId, 'swap')
    prepareSign.mockResolvedValue(mockPrepared(prepared))

    const session = await prepareExternalSignSession({
      source: 'sign-request-tab',
      request: {
        network: 'testnet',
        smartAccountAddress: SMART,
        unsignedTxXdr: unsigned,
        origin: 'https://example.com',
      },
    })

    expect(session.localReview.confirmBlocked).toBe(true)
    expect(session.localReview.code).toBe('contract_mismatch')
  })

  it('surfaces prepareSign failure as flow error (no review)', async () => {
    const nativeId = Asset.native().contractId(Networks.TESTNET)
    const xdr = genericInvokeXdr(nativeId, 'swap')
    prepareSign.mockRejectedValue(
      new BackendError('Latch API unreachable', { code: 'network_error', status: 502 })
    )

    const result = await runExternalSignFlow({
      source: 'sign-request-tab',
      request: {
        network: 'testnet',
        smartAccountAddress: SMART,
        unsignedTxXdr: xdr,
        origin: 'https://example.com',
      },
      waitForDecision: async () => ({ approved: false }),
      enqueueReview: async () => {},
    })

    expect(result).toMatchObject({
      status: 'error',
      code: 'network_error',
      message: 'Latch API unreachable',
    })
    expect(prepareSign).toHaveBeenCalled()
  })
})
