import { Keypair, Networks, TransactionBuilder, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import {
  authEntry,
  authInvocation,
  createContractInvocation,
  invokeTxXdr,
  withAuth,
} from './authTestFixtures'
import { findSelfAccountCalls, flattenAuthInvocation } from './authTree'
import { FEE_FORWARDER_CONTRACT_ID } from './curatedAssets'

const PASSPHRASE = Networks.TESTNET
const ACCOUNT = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const DAPP = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const FEE_FORWARDER = FEE_FORWARDER_CONTRACT_ID.testnet!

const entryXdr = (inv: xdr.SorobanAuthorizedInvocation) => authEntry(ACCOUNT, inv).toXDR('base64')

const find = (args: { txXdr?: string; entriesXdr?: string[] }) =>
  findSelfAccountCalls({ accountId: ACCOUNT, networkPassphrase: PASSPHRASE, ...args })

describe('flattenAuthInvocation', () => {
  it('lists the root first, then sub-invocations depth-first', () => {
    const tree = authInvocation(DAPP, 'swap', [
      authInvocation(DAPP, 'a', [authInvocation(ACCOUNT, 'b')]),
      authInvocation(DAPP, 'c'),
    ])
    expect(flattenAuthInvocation(tree).map((n) => [n.functionName, n.depth])).toEqual([
      ['swap', 0],
      ['a', 1],
      ['b', 2],
      ['c', 1],
    ])
  })

  it('marks create-contract nodes', () => {
    expect(flattenAuthInvocation(createContractInvocation(ACCOUNT))[0]?.kind).toBe(
      'create_contract'
    )
  })
})

describe('findSelfAccountCalls', () => {
  it('finds a root self-call', () => {
    const findings = find({ entriesXdr: [entryXdr(authInvocation(ACCOUNT, 'add_signer'))] })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.node).toMatchObject({ contractId: ACCOUNT, functionName: 'add_signer' })
  })

  it.each([1, 3])('finds a self-call nested at depth %i', (depth) => {
    let tree = authInvocation(ACCOUNT, 'batch_add_signer')
    for (let i = 0; i < depth; i++) tree = authInvocation(DAPP, `hop${i}`, [tree])
    const findings = find({ entriesXdr: [entryXdr(tree)] })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.node.depth).toBe(depth)
  })

  it('finds a self-call below a FeeForwarder forward()', () => {
    const tree = authInvocation(FEE_FORWARDER, 'forward', [authInvocation(ACCOUNT, 'upgrade')])
    expect(find({ entriesXdr: [entryXdr(tree)] })).toHaveLength(1)
  })

  it('finds any function name on the account, not only known admin ones', () => {
    const findings = find({ entriesXdr: [entryXdr(authInvocation(ACCOUNT, 'some_future_fn'))] })
    expect(findings).toHaveLength(1)
  })

  it('finds a create-contract node', () => {
    const findings = find({ entriesXdr: [entryXdr(createContractInvocation(ACCOUNT))] })
    expect(findings[0]?.node.kind).toBe('create_contract')
  })

  it('finds a host function that targets the account directly', () => {
    const findings = find({ txXdr: invokeTxXdr([[ACCOUNT, 'add_signer']]) })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.source).toBe('host_function')
  })

  it('reads auth entries from a tx and reports the given source', () => {
    const tx = withAuth(invokeTxXdr([[DAPP, 'swap']]), [
      authEntry(ACCOUNT, authInvocation(DAPP, 'swap', [authInvocation(ACCOUNT, 'add_signer')])),
    ])
    const findings = findSelfAccountCalls({
      accountId: ACCOUNT,
      txXdr: tx,
      txSource: 'prepared_tx',
      networkPassphrase: PASSPHRASE,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ source: 'prepared_tx', entryIndex: 0 })
  })

  it('looks inside a fee-bump envelope', () => {
    const inner = TransactionBuilder.fromXDR(
      withAuth(invokeTxXdr([[DAPP, 'swap']]), [
        authEntry(ACCOUNT, authInvocation(DAPP, 'swap', [authInvocation(ACCOUNT, 'add_signer')])),
      ]),
      PASSPHRASE
    )
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '200',
      inner as never,
      PASSPHRASE
    )
    expect(find({ txXdr: bump.toXDR() })).toHaveLength(1)
  })

  it('fails closed on an undecodable entry or transaction', () => {
    expect(find({ entriesXdr: ['not-xdr'] })[0]?.node.kind).toBe('unknown')
    expect(find({ txXdr: 'not-xdr' })[0]?.node.kind).toBe('unknown')
  })

  it('fails closed on a transaction with more than one invokeHostFunction op', () => {
    const findings = find({
      txXdr: invokeTxXdr([
        [DAPP, 'a'],
        [DAPP, 'b'],
      ]),
    })
    expect(findings.some((f) => f.node.kind === 'unknown')).toBe(true)
  })

  it('has no findings for a plain dApp call', () => {
    const tx = withAuth(invokeTxXdr([[DAPP, 'swap']]), [
      authEntry(ACCOUNT, authInvocation(DAPP, 'swap')),
    ])
    expect(find({ txXdr: tx, entriesXdr: [entryXdr(authInvocation(DAPP, 'swap'))] })).toEqual([])
  })

  it('has no findings when the account only authorizes a SAC transfer', () => {
    // `from` is the account, but the called contract is the SAC.
    const tree = authInvocation(DAPP, 'transfer')
    expect(find({ entriesXdr: [entryXdr(tree)] })).toEqual([])
  })

  it('has no findings for a forward()-wrapped SAC transfer', () => {
    const tree = authInvocation(FEE_FORWARDER, 'forward', [authInvocation(DAPP, 'transfer')])
    expect(find({ entriesXdr: [entryXdr(tree)] })).toEqual([])
  })

  it('has no findings for a transaction with no auth entries', () => {
    expect(find({ txXdr: invokeTxXdr([[DAPP, 'swap']]) })).toEqual([])
  })
})
