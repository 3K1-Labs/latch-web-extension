import type { CosignRequest } from '@latch/types'
import { Transaction, xdr } from '@stellar/stellar-sdk'

import {
  assembleWithEnforcingSimulation,
  createRpcServer,
  extractInvokeHostAuth,
  replaceInvokeHostAuth,
  sendAndPollSoroban,
} from '@latch/stellar'
import { markCosignSubmitted } from '../api/cosign/cosignQueue'
import { submitTxWebauthn } from '../api/transactions'
import { networkPassphraseFromEnv, sorobanRpcUrlFromEnv } from '../migration/env'

function networkPassphrase(): string {
  return networkPassphraseFromEnv()
}

function rpcUrl(): string {
  return sorobanRpcUrlFromEnv()
}

function transactionFromXdr(xdrB64: string): Transaction {
  const envelope = xdr.TransactionEnvelope.fromXDR(xdrB64, 'base64')
  return new Transaction(envelope, networkPassphrase())
}

/**
 * Merge cosign partial auth entries onto the InvokeHostFunction op (issue #61).
 * Auth must live on op.auth — not only SorobanTransactionData — so enforcing
 * re-simulation can see signed address credentials.
 */
export function mergeCosignAuthEntries(unsignedTxXdr: string, authEntryXdrs: string[]): string {
  const passphrase = networkPassphrase()
  const tx = new Transaction(unsignedTxXdr, passphrase)
  const signedEntries = authEntryXdrs.map((b64) =>
    xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64')
  )
  if (signedEntries.length === 0) {
    return tx.toXDR('base64')
  }
  return replaceInvokeHostAuth(tx, signedEntries, passphrase).toXDR('base64')
}

export async function assembleAndSubmitCosignRequest(args: {
  walletRef: string
  request: CosignRequest
  keyDataHex?: string
  contextRuleId?: number
}): Promise<{ txHash: string }> {
  const authXdrs = (args.request.signatures ?? []).map((s) => s.auth_entry_xdr).filter(Boolean)
  if (authXdrs.length < args.request.threshold) {
    throw new Error('Threshold not met for execution')
  }

  const mergedXdr = mergeCosignAuthEntries(args.request.unsigned_tx_xdr, authXdrs)
  const server = createRpcServer(rpcUrl())
  const tx = transactionFromXdr(mergedXdr)
  // Explicit enforcing re-sim: recording footprint omits __check_auth (issue #61).
  const assembled = await assembleWithEnforcingSimulation(server, tx, networkPassphrase())

  let txHash: string

  if (args.keyDataHex?.trim()) {
    const smartIdx = 0
    const authEntries = extractInvokeHostAuth(assembled)
    const authEntriesXdr = authEntries.map((entry) => entry.toXDR('base64'))
    const submit = await submitTxWebauthn({
      txXdr: assembled.toXDR('base64'),
      authEntryXdr: authEntriesXdr[smartIdx] ?? authXdrs[0]!,
      sigDataXdr: '',
      keyDataHex: args.keyDataHex,
      contextRuleId: args.contextRuleId ?? 0,
      authEntriesXdr,
      smartAccountAuthEntryIndex: smartIdx,
    })
    txHash = String(submit.transactionHash ?? submit.hash ?? '')
    if (!txHash) throw new Error('Submit did not return transaction hash')
  } else {
    const send = await sendAndPollSoroban(server, assembled)
    if (send.status !== 'SUCCESS') throw new Error(send.error ?? 'On-chain submit failed')
    txHash = send.hash
  }

  await markCosignSubmitted(args.walletRef, args.request.id, txHash)
  return { txHash }
}

export function cosignRequestNeedsMySignature(
  request: CosignRequest,
  blindSignerId: string | undefined
): boolean {
  if (!blindSignerId || request.status === 'submitted' || request.status === 'cancelled') {
    return false
  }
  return !(request.signatures ?? []).some((s) => s.blind_signer_id === blindSignerId)
}
