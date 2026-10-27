/**
 * Soroban auth-entry tree inspection. A dApp-built call can make the smart account authorize a call
 * to itself (signer / rule / upgrade changes) several levels below the function the user reviews.
 * Pure helpers: no Chrome, no network, no secrets.
 */

import {
  Address,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'

import type { AuthTreeNode, ExternalSignAuthTreeEntry } from '@latch/types'

import { stellarAddressEquals } from './smartAccountTransactions'

export type { AuthTreeNode }

export type SelfCallFinding = {
  entryIndex: number
  source: 'unsigned' | 'prepared_tx' | 'prepared_entries' | 'host_function'
  node: AuthTreeNode
}

export function unwrapTransaction(envelope: Transaction | FeeBumpTransaction): Transaction {
  if (envelope instanceof FeeBumpTransaction) {
    return envelope.innerTransaction
  }
  return envelope
}

function nodeForFunction(fn: xdr.SorobanAuthorizedFunction, depth: number): AuthTreeNode {
  switch (fn.switch().name) {
    case 'sorobanAuthorizedFunctionTypeContractFn': {
      try {
        const args = fn.contractFn()
        return {
          kind: 'contract_fn',
          contractId: Address.fromScAddress(args.contractAddress()).toString(),
          functionName: args.functionName().toString(),
          depth,
        }
      } catch {
        return { kind: 'unknown', depth }
      }
    }
    case 'sorobanAuthorizedFunctionTypeCreateContractHostFn':
    case 'sorobanAuthorizedFunctionTypeCreateContractV2HostFn':
      return { kind: 'create_contract', depth }
    default:
      return { kind: 'unknown', depth }
  }
}

/** Flatten root + all subInvocations, depth-first, root first. */
export function flattenAuthInvocation(inv: xdr.SorobanAuthorizedInvocation): AuthTreeNode[] {
  const out: AuthTreeNode[] = []
  const walk = (node: xdr.SorobanAuthorizedInvocation, depth: number) => {
    out.push(nodeForFunction(node.function(), depth))
    for (const sub of node.subInvocations()) walk(sub, depth + 1)
  }
  walk(inv, 0)
  return out
}

function isSelfCallOrUnsafe(node: AuthTreeNode, accountId: string): boolean {
  if (node.kind !== 'contract_fn') return true
  return stellarAddressEquals(node.contractId!, accountId)
}

function entryFindings(
  entry: xdr.SorobanAuthorizationEntry,
  entryIndex: number,
  source: SelfCallFinding['source'],
  accountId: string
): SelfCallFinding[] {
  return flattenAuthInvocation(entry.rootInvocation())
    .filter((node) => isSelfCallOrUnsafe(node, accountId))
    .map((node) => ({ entryIndex, source, node }))
}

function unknownFinding(entryIndex: number, source: SelfCallFinding['source']): SelfCallFinding {
  return { entryIndex, source, node: { kind: 'unknown', depth: 0 } }
}

function hostFunctionFinding(func: xdr.HostFunction, accountId: string): SelfCallFinding | null {
  const finding = (node: AuthTreeNode): SelfCallFinding => ({
    entryIndex: -1,
    source: 'host_function',
    node,
  })
  switch (func.switch().name) {
    case 'hostFunctionTypeInvokeContract': {
      try {
        const args = func.invokeContract()
        const contractId = Address.fromScAddress(args.contractAddress()).toString()
        if (!stellarAddressEquals(contractId, accountId)) return null
        return finding({
          kind: 'contract_fn',
          contractId,
          functionName: args.functionName().toString(),
          depth: 0,
        })
      } catch {
        return finding({ kind: 'unknown', depth: 0 })
      }
    }
    case 'hostFunctionTypeCreateContract':
    case 'hostFunctionTypeCreateContractV2':
      return finding({ kind: 'create_contract', depth: 0 })
    default:
      return null
  }
}

/**
 * Self-calls to `accountId` (or create-contract nodes) in any auth entry or the host function.
 * Fails closed: an entry, address or transaction that cannot be decoded produces a finding with
 * kind `unknown`, and so does a transaction with more than one invokeHostFunction operation.
 */
export function findSelfAccountCalls(args: {
  accountId: string
  txXdr?: string
  /** Where `txXdr` came from, for the finding's `source`. */
  txSource?: 'unsigned' | 'prepared_tx'
  networkPassphrase: string
  entriesXdr?: string[]
}): SelfCallFinding[] {
  const findings: SelfCallFinding[] = []
  const txSource = args.txSource ?? 'unsigned'

  if (args.txXdr !== undefined) {
    try {
      const tx = unwrapTransaction(
        TransactionBuilder.fromXDR(args.txXdr, args.networkPassphrase) as
          | Transaction
          | FeeBumpTransaction
      )
      const invokeOps = tx.operations.filter((op) => op.type === 'invokeHostFunction')
      if (invokeOps.length > 1) findings.push(unknownFinding(-1, 'host_function'))
      invokeOps.forEach((op) => {
        if (op.type !== 'invokeHostFunction') return
        const hostFinding = hostFunctionFinding(op.func, args.accountId)
        if (hostFinding) findings.push(hostFinding)
        ;(op.auth ?? []).forEach((entry, index) => {
          try {
            findings.push(...entryFindings(entry, index, txSource, args.accountId))
          } catch {
            findings.push(unknownFinding(index, txSource))
          }
        })
      })
    } catch {
      findings.push(unknownFinding(-1, txSource))
    }
  }

  ;(args.entriesXdr ?? []).forEach((entryXdr, index) => {
    try {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64')
      findings.push(...entryFindings(entry, index, 'prepared_entries', args.accountId))
    } catch {
      findings.push(unknownFinding(index, 'prepared_entries'))
    }
  })

  return findings
}

/** Per-entry trees for the review screen. An entry that can't be decoded is shown as `unknown`. */
export function authTreeForEntries(
  accountId: string,
  entriesXdr: string[]
): ExternalSignAuthTreeEntry[] {
  return entriesXdr.map((entryXdr, entryIndex) => {
    try {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64')
      const nodes = flattenAuthInvocation(entry.rootInvocation()).map((node) => ({
        ...node,
        selfCall: isSelfCallOrUnsafe(node, accountId),
      }))
      return { entryIndex, nodes, selfCall: nodes.some((n) => n.selfCall) }
    } catch {
      return {
        entryIndex,
        nodes: [{ kind: 'unknown' as const, depth: 0, selfCall: true }],
        selfCall: true,
      }
    }
  })
}
