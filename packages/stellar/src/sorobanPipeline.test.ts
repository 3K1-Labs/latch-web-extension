import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  buildWebAuthnAuthPayload,
  countAuthContexts,
  extractInvokeHostAuth,
  replaceInvokeHostAuth,
  setAddressAuthSignature,
  txHasSignedAddressAuth,
} from './sorobanAuth'
import { assembleWithEnforcingSimulation, simulateAndAssembleSoroban } from './sorobanPipeline'
import {
  compareResourceSummaries,
  summarizeSimulationResources,
  type SorobanResourceSummary,
} from './sorobanResources'

const PASSPHRASE = Networks.TESTNET
const SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const VERIFIER = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

function contractId(): string {
  return Asset.native().contractId(PASSPHRASE)
}

function ledgerKeyForContract(id: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(id).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  )
}

function makeAuthEntry(signature: xdr.ScVal): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(SMART).toScAddress(),
        nonce: new xdr.Int64(7),
        signatureExpirationLedger: 999,
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

function makeInvokeTx(auth: xdr.SorobanAuthorizationEntry[]) {
  const kp = Keypair.random()
  const account = new Account(kp.publicKey(), '1')
  const cid = contractId()
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
        auth,
      })
    )
    .setTimeout(30)
    .build()
}

function mockSuccessSim(opts: {
  readOnly: xdr.LedgerKey[]
  readWrite?: xdr.LedgerKey[]
  instructions?: number
  resourceFee?: number
  minResourceFee?: string
  auth?: xdr.SorobanAuthorizationEntry[]
}): rpc.Api.SimulateTransactionSuccessResponse {
  const txData = new SorobanDataBuilder()
    .setResources(opts.instructions ?? 1000, 50, 25)
    .setResourceFee(opts.resourceFee ?? 5000)
    .setReadOnly(opts.readOnly)
    .setReadWrite(opts.readWrite ?? [])
  return {
    // Skip parseRawSimulation inside assembleTransaction (mobile parseSimResult).
    _parsed: true,
    id: 'sim',
    latestLedger: 1,
    events: [],
    transactionData: txData,
    minResourceFee: opts.minResourceFee ?? String(opts.resourceFee ?? 5000),
    result: {
      auth: opts.auth ?? [],
      retval: xdr.ScVal.scvVoid(),
    },
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse
}

describe('buildWebAuthnAuthPayload', () => {
  it('builds External signer map with context_rule_ids', () => {
    const payload = buildWebAuthnAuthPayload(VERIFIER, 'aabb', Buffer.from([1, 2, 3]), [0, 0])
    expect(payload.switch()).toBe(xdr.ScValType.scvMap())
    const map = payload.map()
    expect(map).toBeTruthy()
    const keys = [...(map ?? [])].map((e) => e.key().sym().toString())
    expect(keys).toContain('context_rule_ids')
    expect(keys).toContain('signers')

    const ruleEntry = [...(map ?? [])].find((e) => e.key().sym().toString() === 'context_rule_ids')
    const ruleVec = ruleEntry!.val().vec()!
    expect(ruleVec).toHaveLength(2)
    expect(ruleVec[0]!.u32()).toBe(0)

    const signersEntry = [...(map ?? [])].find((e) => e.key().sym().toString() === 'signers')
    const signers = signersEntry!.val().map()!
    expect(signers).toHaveLength(1)
    const signerKey = signers[0]!.key().vec()!
    expect(signerKey[0]!.sym().toString()).toBe('External')
    expect(Address.fromScAddress(signerKey[1]!.address()).toString()).toBe(VERIFIER)
  })
})

describe('countAuthContexts', () => {
  it('counts root plus nested sub-invocations', () => {
    const leaf = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId()).toScAddress(),
          functionName: 'a',
          args: [],
        })
      ),
      subInvocations: [],
    })
    const root = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId()).toScAddress(),
          functionName: 'b',
          args: [],
        })
      ),
      subInvocations: [leaf, leaf],
    })
    expect(countAuthContexts(root)).toBe(3)
  })
})

describe('compareResourceSummaries', () => {
  const base: SorobanResourceSummary = {
    readOnlyKeys: 2,
    readWriteKeys: 1,
    instructions: 1000,
    diskReadBytes: 10,
    writeBytes: 5,
    resourceFee: 1000n,
    minResourceFee: 1000n,
  }

  it('flags underestimate when enforcing has extra footprint keys', () => {
    const enforcing = { ...base, readOnlyKeys: 5, readWriteKeys: 2 }
    const result = compareResourceSummaries(base, enforcing)
    expect(result.underestimated).toBe(true)
    expect(result.extraReadOnlyKeys).toBe(3)
    expect(result.extraReadWriteKeys).toBe(1)
  })

  it('flags underestimate when enforcing minResourceFee is higher', () => {
    const enforcing = { ...base, minResourceFee: 2500n, resourceFee: 2500n }
    const result = compareResourceSummaries(base, enforcing)
    expect(result.underestimated).toBe(true)
    expect(result.resourceFeeDelta).toBe(1500n)
  })

  it('reports underestimated=false when footprints and fees match', () => {
    const result = compareResourceSummaries(base, { ...base })
    expect(result.underestimated).toBe(false)
    expect(result.extraReadOnlyKeys).toBe(0)
    expect(result.resourceFeeDelta).toBe(0n)
  })
})

describe('summarizeSimulationResources', () => {
  it('reads footprint key counts and fees from sim transactionData', () => {
    const cid = contractId()
    const sim = mockSuccessSim({
      readOnly: [ledgerKeyForContract(cid)],
      readWrite: [ledgerKeyForContract(cid)],
      resourceFee: 4242,
      minResourceFee: '5000',
      instructions: 1234,
    })
    const summary = summarizeSimulationResources(sim)
    expect(summary.readOnlyKeys).toBe(1)
    expect(summary.readWriteKeys).toBe(1)
    expect(summary.instructions).toBe(1234)
    expect(summary.resourceFee).toBe(4242n)
    expect(summary.minResourceFee).toBe(5000n)
  })
})

describe('replaceInvokeHostAuth / txHasSignedAddressAuth', () => {
  it('detects void vs signed address auth and restores auth after replace', () => {
    const unsigned = makeInvokeTx([makeAuthEntry(xdr.ScVal.scvVoid())])
    expect(txHasSignedAddressAuth(unsigned)).toBe(false)

    const signedBytes = Buffer.from('passkey-sig-bytes')
    const signedEntry = makeAuthEntry(xdr.ScVal.scvBytes(signedBytes))
    const signedTx = makeInvokeTx([signedEntry])
    expect(txHasSignedAddressAuth(signedTx)).toBe(true)

    const restored = replaceInvokeHostAuth(unsigned, [signedEntry], PASSPHRASE)
    const auth = extractInvokeHostAuth(restored)
    expect(auth).toHaveLength(1)
    expect(Buffer.from(auth[0]!.credentials().address().signature().bytes()).toString()).toBe(
      'passkey-sig-bytes'
    )
  })
})

describe('assembleWithEnforcingSimulation', () => {
  it('re-simulates once and re-asserts original signed auth bytes', async () => {
    const signedMarker = Buffer.from('keep-me-signed')
    const signedEntry = makeAuthEntry(xdr.ScVal.scvBytes(signedMarker))
    const tx = makeInvokeTx([signedEntry])

    // Sim recommends a different (unsigned) auth — assemble may rewrite; we re-assert.
    const recommended = makeAuthEntry(xdr.ScVal.scvVoid())
    const sim = mockSuccessSim({
      readOnly: [ledgerKeyForContract(contractId())],
      auth: [recommended],
      resourceFee: 8000,
      minResourceFee: '8000',
    })

    const simulateTransaction = vi.fn(async () => sim)
    const server = { simulateTransaction } as unknown as rpc.Server

    const prepared = await assembleWithEnforcingSimulation(server, tx, PASSPHRASE)
    expect(simulateTransaction).toHaveBeenCalledTimes(1)

    const auth = extractInvokeHostAuth(prepared)
    expect(auth).toHaveLength(1)
    expect(Buffer.from(auth[0]!.credentials().address().signature().bytes()).toString()).toBe(
      'keep-me-signed'
    )
    expect(auth[0]!.credentials().address().nonce().toString()).toBe('7')
  })
})

describe('simulateAndAssembleSoroban', () => {
  it('uses a single recording simulation for unsigned auth (migration path)', async () => {
    const unsigned = makeInvokeTx([makeAuthEntry(xdr.ScVal.scvVoid())])
    const sim = mockSuccessSim({
      readOnly: [ledgerKeyForContract(contractId())],
      resourceFee: 3000,
    })
    const simulateTransaction = vi.fn(async () => sim)
    const server = { simulateTransaction } as unknown as rpc.Server

    const assembled = await simulateAndAssembleSoroban(server, unsigned)
    expect(simulateTransaction).toHaveBeenCalledTimes(1)
    expect(txHasSignedAddressAuth(assembled)).toBe(false)
  })

  it('routes signed-auth txs through enforcing assemble', async () => {
    const signed = makeInvokeTx([makeAuthEntry(xdr.ScVal.scvBytes(Buffer.from('sig')))])
    const sim = mockSuccessSim({
      readOnly: [ledgerKeyForContract(contractId())],
      resourceFee: 4000,
    })
    const simulateTransaction = vi.fn(async () => sim)
    const server = { simulateTransaction } as unknown as rpc.Server

    const assembled = await simulateAndAssembleSoroban(server, signed)
    expect(simulateTransaction).toHaveBeenCalledTimes(1)
    expect(txHasSignedAddressAuth(assembled)).toBe(true)
  })
})

describe('setAddressAuthSignature', () => {
  it('attaches WebAuthn AuthPayload without mutating the original entry', () => {
    const original = makeAuthEntry(xdr.ScVal.scvVoid())
    const payload = buildWebAuthnAuthPayload(VERIFIER, 'deadbeef', Buffer.from([9]), [3])
    const updated = setAddressAuthSignature(original, payload)
    expect(original.credentials().address().signature().switch()).toBe(xdr.ScValType.scvVoid())
    expect(updated.credentials().address().signature().switch()).toBe(xdr.ScValType.scvMap())
  })
})
