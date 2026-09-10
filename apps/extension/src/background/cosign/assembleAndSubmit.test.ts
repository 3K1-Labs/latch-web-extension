import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CosignRequest } from '@latch/types'

const PASSPHRASE = Networks.TESTNET
const SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'

const {
  assembleWithEnforcingSimulation,
  sendAndPollSoroban,
  createRpcServer,
  markCosignSubmitted,
  submitTxWebauthn,
} = vi.hoisted(() => ({
  assembleWithEnforcingSimulation: vi.fn(),
  sendAndPollSoroban: vi.fn(),
  createRpcServer: vi.fn(() => ({ simulateTransaction: vi.fn() })),
  markCosignSubmitted: vi.fn(async () => undefined),
  submitTxWebauthn: vi.fn(async () => ({ transactionHash: 'HASH_WEBAUTHN' })),
}))

vi.mock('@latch/stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@latch/stellar')>()
  return {
    ...actual,
    assembleWithEnforcingSimulation,
    sendAndPollSoroban,
    createRpcServer,
  }
})

vi.mock('../api/cosign/cosignQueue', () => ({
  markCosignSubmitted,
}))

vi.mock('../api/transactions', () => ({
  submitTxWebauthn,
}))

vi.mock('../migration/env', () => ({
  networkPassphraseFromEnv: () => PASSPHRASE,
  sorobanRpcUrlFromEnv: () => 'https://soroban-testnet.stellar.org',
}))

import { extractInvokeHostAuth } from '@latch/stellar'
import {
  assembleAndSubmitCosignRequest,
  cosignRequestNeedsMySignature,
  mergeCosignAuthEntries,
} from './assembleAndSubmit'

function contractId(): string {
  return Asset.native().contractId(PASSPHRASE)
}

function makeAuthEntry(signature: xdr.ScVal): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(SMART).toScAddress(),
        nonce: new xdr.Int64(3),
        signatureExpirationLedger: 500,
        signature,
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId()).toScAddress(),
          functionName: 'transfer',
          args: [],
        })
      ),
      subInvocations: [],
    }),
  })
}

function makeUnsignedInvokeTxXdr(): string {
  const kp = Keypair.random()
  const account = new Account(kp.publicKey(), '1')
  const cid = contractId()
  const txData = new SorobanDataBuilder()
    .setResources(1000, 50, 25)
    .setResourceFee(5000)
    .setReadOnly([])
    .setReadWrite([])
    .build()

  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(cid).toScAddress(),
            functionName: 'transfer',
            args: [
              Address.fromString(SMART).toScVal(),
              Address.fromString(SMART).toScVal(),
              nativeToScVal(1n, { type: 'i128' }),
            ],
          })
        ),
        auth: [makeAuthEntry(xdr.ScVal.scvVoid())],
      })
    )
    .setSorobanData(txData)
    .setTimeout(30)
    .build()
    .toXDR()
}

function baseRequest(overrides: Partial<CosignRequest> = {}): CosignRequest {
  return {
    id: 'req-1',
    queue_index: 'qi',
    unsigned_tx_xdr: makeUnsignedInvokeTxXdr(),
    network: 'testnet',
    threshold: 1,
    status: 'pending',
    submitted_tx_hash: '',
    expires_at: '',
    created_at: '',
    updated_at: '',
    signatures: [
      {
        id: 'sig-1',
        blind_signer_id: 'blind-a',
        auth_entry_xdr: makeAuthEntry(xdr.ScVal.scvBytes(Buffer.from('cosign-sig'))).toXDR(
          'base64'
        ),
        created_at: '',
      },
    ],
    signature_count: 1,
    ...overrides,
  }
}

describe('mergeCosignAuthEntries', () => {
  it('places signed auth on InvokeHostFunction op.auth', () => {
    const unsigned = makeUnsignedInvokeTxXdr()
    const signed = makeAuthEntry(xdr.ScVal.scvBytes(Buffer.from('merged-sig')))
    const mergedXdr = mergeCosignAuthEntries(unsigned, [signed.toXDR('base64')])
    const auth = extractInvokeHostAuth(new Transaction(mergedXdr, PASSPHRASE))
    expect(auth).toHaveLength(1)
    expect(Buffer.from(auth[0]!.credentials().address().signature().bytes()).toString()).toBe(
      'merged-sig'
    )
  })
})

describe('assembleAndSubmitCosignRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createRpcServer.mockReturnValue({ simulateTransaction: vi.fn() })
  })

  it('runs enforcing assemble once and preserves signed op.auth before local submit', async () => {
    const request = baseRequest()
    const signedMarker = Buffer.from('cosign-sig')

    assembleWithEnforcingSimulation.mockImplementation(async (_server, tx) => {
      const auth = extractInvokeHostAuth(tx)
      expect(auth).toHaveLength(1)
      expect(Buffer.from(auth[0]!.credentials().address().signature().bytes()).toString()).toBe(
        signedMarker.toString()
      )
      return tx
    })
    sendAndPollSoroban.mockResolvedValue({ status: 'SUCCESS', hash: 'HASH_LOCAL' })

    const result = await assembleAndSubmitCosignRequest({
      walletRef: 'wallet-ref',
      request,
    })

    expect(assembleWithEnforcingSimulation).toHaveBeenCalledTimes(1)
    expect(sendAndPollSoroban).toHaveBeenCalledTimes(1)
    expect(submitTxWebauthn).not.toHaveBeenCalled()
    expect(markCosignSubmitted).toHaveBeenCalledWith('wallet-ref', 'req-1', 'HASH_LOCAL')
    expect(result.txHash).toBe('HASH_LOCAL')
  })

  it('submits via webauthn when keyDataHex is provided', async () => {
    const request = baseRequest()
    assembleWithEnforcingSimulation.mockImplementation(async (_server, tx) => tx)
    submitTxWebauthn.mockResolvedValue({ transactionHash: 'HASH_WEBAUTHN' })

    const result = await assembleAndSubmitCosignRequest({
      walletRef: 'wallet-ref',
      request,
      keyDataHex: 'aabb',
      contextRuleId: 0,
    })

    expect(assembleWithEnforcingSimulation).toHaveBeenCalledTimes(1)
    expect(submitTxWebauthn).toHaveBeenCalledTimes(1)
    expect(sendAndPollSoroban).not.toHaveBeenCalled()
    expect(result.txHash).toBe('HASH_WEBAUTHN')
  })

  it('rejects when signature threshold is not met', async () => {
    const request = baseRequest({ threshold: 2, signatures: [] })
    await expect(assembleAndSubmitCosignRequest({ walletRef: 'w', request })).rejects.toThrow(
      /Threshold not met/
    )
    expect(assembleWithEnforcingSimulation).not.toHaveBeenCalled()
  })
})

describe('cosignRequestNeedsMySignature', () => {
  it('returns false when already signed or terminal', () => {
    const request = baseRequest()
    expect(cosignRequestNeedsMySignature(request, 'blind-a')).toBe(false)
    expect(cosignRequestNeedsMySignature({ ...request, status: 'submitted' }, 'blind-b')).toBe(
      false
    )
  })

  it('returns true when pending and my blind id is missing', () => {
    const request = baseRequest()
    expect(cosignRequestNeedsMySignature(request, 'blind-b')).toBe(true)
  })
})
