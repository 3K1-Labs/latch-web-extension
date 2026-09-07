import {
  Account,
  Asset,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { buildUnsignedSacTransferTx } from './sacTransfer'
import { assessExternalSignReview, parseTxForReview } from './parseTxForReview'

const PASSPHRASE = Networks.TESTNET
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function makeAccount(): { account: Account; keypair: Keypair } {
  const keypair = Keypair.random()
  return { account: new Account(keypair.publicKey(), '1'), keypair }
}

function sacTransferXdr(params: {
  sacContractId: string
  toCAddress: string
  amountRaw: bigint
}): string {
  const { account, keypair } = makeAccount()
  const tx = buildUnsignedSacTransferTx({
    sourceAccount: account,
    sacContractId: params.sacContractId,
    fromGAddress: keypair.publicKey(),
    toCAddress: params.toCAddress,
    amountRaw: params.amountRaw,
    networkPassphrase: PASSPHRASE,
    fee: '100',
  })
  return tx.toXDR()
}

function genericInvokeXdr(params: { contractId: string; fn: string }): string {
  const { account } = makeAccount()
  const contract = new Contract(params.contractId)
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(params.fn, nativeToScVal(1, { type: 'u32' })))
    .setTimeout(30)
    .build()
  return tx.toXDR()
}

const TO_C = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'

describe('parseTxForReview', () => {
  it('summarizes SAC transfer with amount and truncated to', () => {
    const nativeId = Asset.native().contractId(PASSPHRASE)
    const xdr = sacTransferXdr({
      sacContractId: nativeId,
      toCAddress: TO_C,
      amountRaw: 12_500_000n,
    })
    const parsed = parseTxForReview(xdr, PASSPHRASE)
    expect(parsed.invokeContractIds).toEqual([nativeId])
    expect(parsed.operations).toHaveLength(1)
    expect(parsed.operations[0]?.type).toBe('sac_transfer')
    expect(parsed.operations[0]?.summary).toContain('Transfer')
    expect(parsed.operations[0]?.summary).toContain('1.25')
    expect(parsed.operations[0]?.summary).toContain('XLM')
    expect(parsed.operations[0]?.summary).toMatch(/CDBBGL\.\.\.PBVY/)
  })

  it('summarizes generic invokeHostFunction as Call contract::fn', () => {
    const contractId = Asset.native().contractId(PASSPHRASE)
    const xdr = genericInvokeXdr({ contractId, fn: 'swap' })
    const parsed = parseTxForReview(xdr, PASSPHRASE)
    expect(parsed.invokeContractIds).toEqual([contractId])
    expect(parsed.operations[0]?.type).toBe('invoke_contract')
    expect(parsed.operations[0]?.summary).toMatch(/^Call CDLZFC\.\.\.CYSC::swap$/)
    expect(parsed.operations[0]?.details).toMatchObject({
      contract: contractId,
      function: 'swap',
    })
  })

  it('throws on invalid XDR', () => {
    expect(() => parseTxForReview('not-valid-xdr', PASSPHRASE)).toThrow()
  })
})

describe('assessExternalSignReview', () => {
  const smart = TO_C
  const nativeId = Asset.native().contractId(PASSPHRASE)
  const usdcId = new Asset('USDC', USDC_ISSUER).contractId(PASSPHRASE)

  it('allows confirm when unsigned and prepared invoke the same contract', () => {
    const unsigned = genericInvokeXdr({ contractId: nativeId, fn: 'unknown_fn' })
    const prepared = genericInvokeXdr({ contractId: nativeId, fn: 'unknown_fn' })
    const review = assessExternalSignReview({
      unsignedTxXdr: unsigned,
      preparedTxXdr: prepared,
      networkPassphrase: PASSPHRASE,
      signRequestNetwork: 'testnet',
      preparedNetwork: 'testnet',
      activeNetwork: 'testnet',
      signRequestSmartAccount: smart,
      preparedSmartAccount: smart,
      activeSmartAccount: smart,
    })
    expect(review.confirmBlocked).toBe(false)
    expect(review.code).toBeUndefined()
    expect(review.operations[0]?.summary).toContain('unknown_fn')
  })

  it('blocks on contract id mismatch between unsigned and prepared', () => {
    const unsigned = sacTransferXdr({
      sacContractId: nativeId,
      toCAddress: TO_C,
      amountRaw: 1_000_000n,
    })
    const prepared = sacTransferXdr({
      sacContractId: usdcId,
      toCAddress: TO_C,
      amountRaw: 1_000_000n,
    })
    const review = assessExternalSignReview({
      unsignedTxXdr: unsigned,
      preparedTxXdr: prepared,
      networkPassphrase: PASSPHRASE,
      signRequestNetwork: 'testnet',
      preparedNetwork: 'testnet',
      activeNetwork: 'testnet',
      signRequestSmartAccount: smart,
      preparedSmartAccount: smart,
      activeSmartAccount: smart,
    })
    expect(review.confirmBlocked).toBe(true)
    expect(review.code).toBe('contract_mismatch')
    expect(review.operations[0]?.type).toBe('sac_transfer')
  })

  it('blocks on unparseable unsigned XDR', () => {
    const prepared = genericInvokeXdr({ contractId: nativeId, fn: 'swap' })
    const review = assessExternalSignReview({
      unsignedTxXdr: '!!!',
      preparedTxXdr: prepared,
      networkPassphrase: PASSPHRASE,
      signRequestNetwork: 'testnet',
      preparedNetwork: 'testnet',
      activeNetwork: 'testnet',
      signRequestSmartAccount: smart,
      preparedSmartAccount: smart,
      activeSmartAccount: smart,
    })
    expect(review.confirmBlocked).toBe(true)
    expect(review.code).toBe('unparseable_xdr')
  })

  it('blocks on network mismatch', () => {
    const xdr = genericInvokeXdr({ contractId: nativeId, fn: 'swap' })
    const review = assessExternalSignReview({
      unsignedTxXdr: xdr,
      preparedTxXdr: xdr,
      networkPassphrase: PASSPHRASE,
      signRequestNetwork: 'testnet',
      preparedNetwork: 'testnet',
      activeNetwork: 'mainnet',
      signRequestSmartAccount: smart,
      preparedSmartAccount: smart,
      activeSmartAccount: smart,
    })
    expect(review.confirmBlocked).toBe(true)
    expect(review.code).toBe('network_mismatch')
  })

  it('blocks on account mismatch', () => {
    const xdr = genericInvokeXdr({ contractId: nativeId, fn: 'swap' })
    const otherC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
    const review = assessExternalSignReview({
      unsignedTxXdr: xdr,
      preparedTxXdr: xdr,
      networkPassphrase: PASSPHRASE,
      signRequestNetwork: 'testnet',
      preparedNetwork: 'testnet',
      activeNetwork: 'testnet',
      signRequestSmartAccount: smart,
      preparedSmartAccount: smart,
      activeSmartAccount: otherC,
    })
    expect(review.confirmBlocked).toBe(true)
    expect(review.code).toBe('account_mismatch')
  })
})
