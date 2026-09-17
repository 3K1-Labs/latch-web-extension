import type {
  ExecuteRemoveAccountSignerRequest,
  ExecuteRemoveAccountSignerResponse,
  StoredAccount,
  SubmitTxResponse,
} from '@latch/types'

import { confirmRemoveAccountSigner, removeAccountSigner } from '../api/accountSigners'
import { BackendError } from '../api/client'
import { deleteAccountSignerRecord } from '../storage'
import { signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'
import { confirmWithSettlementRetry } from './confirmRetry'

function transactionHashOf(data: SubmitTxResponse | undefined): string | undefined {
  if (!data) return undefined
  if (typeof data.transactionHash === 'string' && data.transactionHash) return data.transactionHash
  if (typeof data.hash === 'string' && data.hash) return data.hash
  return undefined
}

function contextRuleIdOf(value: number | string | undefined): number {
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? Number(n) : 0
}

/**
 * Revoke a backup passkey's on-chain authorization, signed by the credential
 * this install already holds.
 *
 * The local record is dropped only after the removal settles: dropping it
 * early would hide a signer that can still spend.
 */
export async function executeRemoveAccountSignerInBackground(args: {
  activeAccount: StoredAccount
  req: ExecuteRemoveAccountSignerRequest
}): Promise<ExecuteRemoveAccountSignerResponse> {
  const { activeAccount, req } = args
  const smartAccountAddress = activeAccount.smartAccountAddress
  const credentialId = req.credentialId.trim()
  if (!credentialId) throw new Error('Missing signer credential id.')
  if (credentialId === activeAccount.passkeyCredentialId?.trim()) {
    throw new Error('This is the passkey this device signs with. Remove a backup passkey instead.')
  }

  const build = await removeAccountSigner({ smartAccountAddress, credentialId })
  const submitted = await signAndSubmitBuiltTxInBackground({ build, activeAccount })
  const txHash = transactionHashOf(submitted)
  if (!txHash) {
    throw new BackendError(
      'The remove-signer transaction was submitted but returned no hash, so it could not be confirmed. Try again once it settles.',
      { code: 'signer_confirm_missing_hash' }
    )
  }

  const confirmed = await confirmWithSettlementRetry(() =>
    confirmRemoveAccountSigner({
      smartAccountAddress,
      credentialId,
      contextRuleId: contextRuleIdOf(build.contextRuleId),
      txHash,
    })
  )

  await deleteAccountSignerRecord(smartAccountAddress, credentialId)
  return {
    smartAccountAddress,
    credentialId,
    txHash,
    alreadyRemoved: confirmed.alreadyRemoved,
  }
}
