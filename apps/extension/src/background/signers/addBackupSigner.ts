import type {
  AccountSignerRecord,
  ExecuteAddBackupSignerRequest,
  ExecuteAddBackupSignerResponse,
  StoredAccount,
  SubmitTxResponse,
} from '@latch/types'

import { addAccountSigner, confirmAddAccountSigner } from '../api/accountSigners'
import { BackendError } from '../api/client'
import { getAccountSignerRecords, upsertAccountSignerRecord } from '../storage'
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
 * Authorize an already-attached backup passkey on the account's Default rule.
 *
 * Order matters: the credential is only indexed for fresh-device restore after
 * `add_signer` settles. Indexing a credential that never made it on-chain is
 * the worst failure available — restore would hand the user a wallet they
 * cannot sign for.
 */
export async function executeAddBackupSignerInBackground(args: {
  activeAccount: StoredAccount
  req: ExecuteAddBackupSignerRequest
}): Promise<ExecuteAddBackupSignerResponse> {
  const { activeAccount, req } = args
  const smartAccountAddress = activeAccount.smartAccountAddress
  const credentialId = req.credentialId.trim()
  if (!credentialId) throw new Error('Missing backup passkey credential id.')

  const stored = (await getAccountSignerRecords(smartAccountAddress)).find(
    (s) => s.credentialId === credentialId
  )
  const keyDataHex = (req.keyDataHex ?? stored?.keyDataHex)?.trim()
  if (!keyDataHex) {
    throw new Error('This backup passkey has no key data on this device. Add it again.')
  }
  const label = req.label ?? stored?.label
  const seq = req.seq ?? stored?.seq

  const persist = async (patch: Partial<AccountSignerRecord>): Promise<AccountSignerRecord> => {
    const record: AccountSignerRecord = {
      credentialId,
      keyDataHex,
      label,
      seq,
      role: 'backup',
      status: 'pending',
      addedAt: stored?.addedAt ?? Date.now(),
      ...patch,
    }
    await upsertAccountSignerRecord(smartAccountAddress, record)
    return record
  }

  const runConfirm = async (
    txHash: string,
    contextRuleId: number
  ): Promise<ExecuteAddBackupSignerResponse> => {
    const confirmed = await confirmWithSettlementRetry(() =>
      confirmAddAccountSigner({
        smartAccountAddress,
        contextRuleId,
        keyDataHex,
        credentialId,
        label,
        seq,
        txHash,
      })
    )
    const signer = await persist({
      status: 'onchain',
      signerId: confirmed.signerId,
      pendingConfirm: undefined,
    })
    return { smartAccountAddress, signer, txHash }
  }

  // Retry path: the chain call already landed, only the index write failed.
  if (req.resumeConfirmOnly) {
    const pending = stored?.pendingConfirm
    if (!pending?.txHash) {
      throw new Error('Nothing to finish for this passkey. Remove it and add it again.')
    }
    return await runConfirm(pending.txHash, pending.contextRuleId)
  }

  const build = await addAccountSigner({ smartAccountAddress, keyDataHex, credentialId })

  if (build.alreadyConfigured) {
    // Already authorized on-chain (a repeat add, or a retry after the submit
    // landed but the response was lost). There is no hash to confirm with, so
    // the recovery index may still be missing its row.
    const signer = await persist({ status: 'onchain', pendingConfirm: undefined })
    return { smartAccountAddress, signer, alreadyConfigured: true }
  }

  const submitted = await signAndSubmitBuiltTxInBackground({ build, activeAccount })
  const txHash = transactionHashOf(submitted)
  if (!txHash) {
    throw new BackendError(
      'The add-signer transaction was submitted but returned no hash, so it could not be confirmed. Open Signers and finish setup once it settles.',
      { code: 'signer_confirm_missing_hash' }
    )
  }

  const contextRuleId = contextRuleIdOf(build.contextRuleId)
  await persist({ pendingConfirm: { txHash, contextRuleId } })
  return await runConfirm(txHash, contextRuleId)
}
