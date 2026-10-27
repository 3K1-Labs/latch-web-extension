import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { authEntry, authInvocation, withAuth } from './authTestFixtures'
import { FEE_FORWARDER_CONTRACT_ID } from './curatedAssets'
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
const FEE_FORWARDER = FEE_FORWARDER_CONTRACT_ID.testnet!
/** Not curated on testnet, so it has no symbol and is not an allowed fee token. */
const OTHER_C = new Asset('EVIL', USDC_ISSUER).contractId(PASSPHRASE)
const OTHER_C_SHORT = `${OTHER_C.slice(0, 6)}...${OTHER_C.slice(-4)}`

function forwardXdr(params: {
  forwarder: string
  feeToken: string
  target: string
  targetFn?: string
  targetArgs?: xdr.ScVal[]
  user: string
  maxFeeRaw?: bigint
}): string {
  const { account, keypair } = makeAccount()
  const args = [
    new Address(params.feeToken).toScVal(),
    nativeToScVal(1n, { type: 'i128' }),
    nativeToScVal(params.maxFeeRaw ?? 140_000n, { type: 'i128' }),
    nativeToScVal(1120, { type: 'u32' }),
    new Address(params.target).toScVal(),
    xdr.ScVal.scvSymbol(params.targetFn ?? 'transfer'),
    xdr.ScVal.scvVec(
      params.targetArgs ?? [
        new Address(params.user).toScVal(),
        new Address(TO_C).toScVal(),
        nativeToScVal(25_000_000n, { type: 'i128' }),
      ]
    ),
    new Address(params.user).toScVal(),
    new Address(keypair.publicKey()).toScVal(),
  ]
  return new TransactionBuilder(account, { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(params.forwarder).call('forward', ...args))
    .setTimeout(30)
    .build()
    .toXDR()
}

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

  it('presents the inner transfer and max fee of a FeeForwarder forward() call', () => {
    const nativeId = Asset.native().contractId(PASSPHRASE)
    const xdrStr = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: TO_C,
    })

    const parsed = parseTxForReview(xdrStr, PASSPHRASE, { feeForwarderId: FEE_FORWARDER })
    expect(parsed.invokeContractIds).toEqual([FEE_FORWARDER, nativeId])
    expect(parsed.forwardUsers).toEqual([TO_C])
    expect(parsed.warnings).toEqual([])
    expect(parsed.operations).toHaveLength(2)
    expect(parsed.operations[0]?.type).toBe('sac_transfer')
    expect(parsed.operations[0]?.summary).toContain('2.5 XLM')
    expect(parsed.operations[1]).toMatchObject({
      type: 'network_fee',
      summary: 'Network fee up to 0.014 XLM',
      details: { feeToken: nativeId, maxFeeAmount: '140000', symbol: 'XLM', user: TO_C },
    })
  })

  it('keeps forward() on a contract other than the FeeForwarder opaque', () => {
    const usdcId = new Asset('USDC', USDC_ISSUER).contractId(PASSPHRASE)
    const xdrStr = forwardXdr({
      forwarder: OTHER_C,
      feeToken: usdcId,
      target: usdcId,
      user: TO_C,
      maxFeeRaw: 1n,
    })

    const parsed = parseTxForReview(xdrStr, PASSPHRASE, { feeForwarderId: FEE_FORWARDER })
    expect(parsed.invokeContractIds).toEqual([OTHER_C])
    expect(parsed.forwardUsers).toEqual([])
    expect(parsed.operations).toHaveLength(1)
    expect(parsed.operations[0]).toMatchObject({
      type: 'invoke_contract',
      summary: `Call ${OTHER_C_SHORT}::forward`,
    })
  })

  it('defaults to the known testnet FeeForwarder when opts omit an id', () => {
    const nativeId = Asset.native().contractId(PASSPHRASE)
    const xdrStr = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: TO_C,
    })

    const parsed = parseTxForReview(xdrStr, PASSPHRASE)
    expect(parsed.invokeContractIds).toEqual([FEE_FORWARDER, nativeId])
    expect(parsed.operations[1]?.type).toBe('network_fee')
  })

  it('never unwraps forward() when FeeForwarder is explicitly unset', () => {
    const nativeId = Asset.native().contractId(PASSPHRASE)
    const xdrStr = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: TO_C,
    })

    const parsed = parseTxForReview(xdrStr, PASSPHRASE, { feeForwarderId: undefined })
    expect(parsed.invokeContractIds).toEqual([FEE_FORWARDER])
    expect(parsed.operations[0]?.type).toBe('invoke_contract')
  })

  it('names an uncurated fee token and warns about it', () => {
    const nativeId = Asset.native().contractId(PASSPHRASE)
    const xdrStr = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: OTHER_C,
      target: nativeId,
      user: TO_C,
    })

    const parsed = parseTxForReview(xdrStr, PASSPHRASE, { feeForwarderId: FEE_FORWARDER })
    const fee = parsed.operations.find((op) => op.type === 'network_fee')
    expect(fee?.summary).toBe(`Network fee up to 0.014 of ${OTHER_C_SHORT}`)
    expect(fee?.details?.symbol).toBeUndefined()
    expect(fee?.details?.feeTokenWarning).toBe('unexpected_fee_token')
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toContain('not XLM or USDC')
  })

  it('does not warn when the fee is paid in USDC', () => {
    const usdcId = new Asset('USDC', USDC_ISSUER).contractId(PASSPHRASE)
    const xdrStr = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: usdcId,
      target: usdcId,
      user: TO_C,
    })

    const parsed = parseTxForReview(xdrStr, PASSPHRASE, { feeForwarderId: FEE_FORWARDER })
    expect(parsed.warnings).toEqual([])
    expect(parsed.operations[1]?.summary).toBe('Network fee up to 0.014 USDC')
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

  it('blocks on unparsable unsigned XDR', () => {
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
    expect(review.code).toBe('unparsable_xdr')
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

  const assess = (unsignedTxXdr: string, preparedTxXdr: string) =>
    assessExternalSignReview({
      unsignedTxXdr,
      preparedTxXdr,
      networkPassphrase: PASSPHRASE,
      signRequestNetwork: 'testnet',
      preparedNetwork: 'testnet',
      activeNetwork: 'testnet',
      signRequestSmartAccount: smart,
      preparedSmartAccount: smart,
      activeSmartAccount: smart,
      feeForwarderId: FEE_FORWARDER,
    })

  it('allows a plain dApp call that prepare-sign wrapped in the FeeForwarder, and shows its fee', () => {
    const unsigned = sacTransferXdr({ sacContractId: nativeId, toCAddress: TO_C, amountRaw: 1n })
    const prepared = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: smart,
    })
    const review = assess(unsigned, prepared)
    expect(review.confirmBlocked).toBe(false)
    expect(review.operations.map((op) => op.type)).toEqual(['sac_transfer', 'network_fee'])
    expect(review.operations[1]?.summary).toBe('Network fee up to 0.014 XLM')
  })

  it('blocks when forward() charges a different user than the active wallet', () => {
    const forwarded = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: OTHER_C,
    })
    const review = assess(forwarded, forwarded)
    expect(review.confirmBlocked).toBe(true)
    expect(review.code).toBe('user_mismatch')
  })

  it('blocks when only the prepared forward() charges a different user', () => {
    const unsigned = sacTransferXdr({ sacContractId: nativeId, toCAddress: TO_C, amountRaw: 1n })
    const prepared = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: OTHER_C,
    })
    const review = assess(unsigned, prepared)
    expect(review.confirmBlocked).toBe(true)
    expect(review.code).toBe('user_mismatch')
  })

  it('blocks when the prepared forward() wraps a different target', () => {
    const unsigned = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: smart,
    })
    const prepared = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: usdcId,
      user: smart,
    })
    const review = assess(unsigned, prepared)
    expect(review.confirmBlocked).toBe(true)
    expect(review.code).toBe('contract_mismatch')
  })

  it('blocks a lookalike forward() whose prepared tx targets only the inner token', () => {
    const unsigned = forwardXdr({
      forwarder: OTHER_C,
      feeToken: usdcId,
      target: usdcId,
      user: smart,
      maxFeeRaw: 1n,
    })
    const prepared = sacTransferXdr({ sacContractId: usdcId, toCAddress: TO_C, amountRaw: 1n })
    const review = assess(unsigned, prepared)
    expect(review.confirmBlocked).toBe(true)
    expect(review.code).toBe('contract_mismatch')
    expect(review.operations[0]?.summary).toBe(`Call ${OTHER_C_SHORT}::forward`)
  })

  it('surfaces the uncurated fee-token warning on an otherwise valid review', () => {
    const forwarded = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: OTHER_C,
      target: nativeId,
      user: smart,
    })
    const review = assess(forwarded, forwarded)
    expect(review.confirmBlocked).toBe(false)
    expect(review.warnings?.[0]).toContain('not XLM or USDC')
  })

  it("shows the prepared fee, not the dApp's own forward() fee, and warns when they differ", () => {
    const unsigned = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: smart,
      maxFeeRaw: 10_000n,
    })
    const prepared = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: smart,
      maxFeeRaw: 200_000n,
    })
    const review = assess(unsigned, prepared)
    expect(review.confirmBlocked).toBe(false)
    const fees = review.operations.filter((op) => op.type === 'network_fee')
    expect(fees).toHaveLength(1)
    expect(fees[0]?.summary).toBe('Network fee up to 0.02 XLM')
    expect(review.warnings?.some((w) => w.includes('network fee differently'))).toBe(true)
  })

  it('warns when the fee cap is the same number but in a different token', () => {
    const unsigned = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: usdcId,
      target: nativeId,
      user: smart,
    })
    const prepared = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: smart,
    })
    const review = assess(unsigned, prepared)
    expect(review.confirmBlocked).toBe(false)
    expect(review.warnings?.some((w) => w.includes('network fee differently'))).toBe(true)
  })

  it('warns when the prepared transaction carries no fee the dApp had requested', () => {
    const unsigned = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: smart,
    })
    const prepared = sacTransferXdr({
      sacContractId: nativeId,
      toCAddress: TO_C,
      amountRaw: 25_000_000n,
    })
    const review = assess(unsigned, prepared)
    expect(review.operations.some((op) => op.type === 'network_fee')).toBe(false)
    expect(review.warnings?.some((w) => w.includes('removed the network fee'))).toBe(true)
  })

  it('does not warn when the dApp forward() fee matches the prepared fee', () => {
    const forwarded = forwardXdr({
      forwarder: FEE_FORWARDER,
      feeToken: nativeId,
      target: nativeId,
      user: smart,
    })
    const review = assess(forwarded, forwarded)
    expect(review.operations.filter((op) => op.type === 'network_fee')).toHaveLength(1)
    expect(review.warnings).toBeUndefined()
  })

  it('GHSA-8hrp: confirms a dApp call whose auth tree calls the wallet own batch_add_signer', () => {
    const tx = withAuth(genericInvokeXdr({ contractId: OTHER_C, fn: 'swap' }), [
      authEntry(
        smart,
        authInvocation(OTHER_C, 'swap', [authInvocation(smart, 'batch_add_signer')])
      ),
    ])
    const review = assess(tx, tx)
    // Reproduces the advisory: nothing inspects the auth tree yet.
    expect(review.confirmBlocked).toBe(false)
  })
})
