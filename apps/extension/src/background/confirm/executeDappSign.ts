import type { BuildSendTxResponse, ResolvePendingDappRequest, SubmitTxResponse } from '@latch/types'
import {
  assessExternalSignReview,
  findSelfAccountCalls,
  stellarAddressEquals,
} from '@latch/stellar'

import { closeApprovalWindowForOrigin, resolveDappRequestDecision } from '../dapp/approvalSession'
import { getDappRequest, markDappRequestSigning } from '../dapp/requestState'
import { preparedAuthEntryXdrs } from '../externalSign/preparedAuthEntries'
import {
  feeForwarderContractIdFor,
  getActiveNetwork,
  networkPassphraseFor,
} from '../network/config'
import { getAccounts } from '../storage'
import { signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'

async function resolvePending(req: ResolvePendingDappRequest): Promise<string | undefined> {
  const record = await resolveDappRequestDecision(req)
  return record?.origin
}

/** Fails the pending request (the dApp gets `status: 'error'`) and closes its approval window. */
async function failPending(requestId: string, errorCode: string, message: string): Promise<void> {
  const origin = await resolvePending({
    requestId,
    approved: false,
    errorMessage: message,
    errorCode,
  }).catch(() => undefined)
  if (origin) await closeApprovalWindowForOrigin(origin).catch(() => {})
}

async function refuse(requestId: string, errorCode: string, message: string): Promise<never> {
  await failPending(requestId, errorCode, message)
  throw new Error(message)
}

export async function executeDappExternalSignInBackground(args: {
  requestId: string
  accountId: string
  /**
   * Sent by the UI but never signed: the request stored by the background is authoritative, so a
   * crafted message cannot swap in bytes the user did not review.
   */
  prepared: BuildSendTxResponse
  submit: boolean
}): Promise<{
  signedTxXdr?: string
  signedAuthEntry?: string
  txHash?: string
  submitData?: SubmitTxResponse
}> {
  const { accounts } = await getAccounts()
  const activeAccount = accounts.find((a) => a.id === args.accountId)
  if (!activeAccount) throw new Error('No active account')

  const pending = await getDappRequest(args.requestId)
  if (
    !pending ||
    pending.kind !== 'externalSignReview' ||
    !pending.prepared ||
    !pending.signRequest
  ) {
    throw new Error('This signing request is no longer available.')
  }
  if (pending.status !== 'awaiting_user') {
    throw new Error('This signing request was already handled.')
  }
  const { prepared, signRequest } = pending

  if (
    !activeAccount.smartAccountAddress ||
    !stellarAddressEquals(signRequest.smartAccountAddress, activeAccount.smartAccountAddress)
  ) {
    return refuse(
      args.requestId,
      'account_mismatch',
      'This request was prepared for a different wallet than the active one.'
    )
  }

  // Everything below runs before any signer: no passkey prompt, no seed key use.
  const networkPassphrase = networkPassphraseFor(signRequest.network)
  const entries = preparedAuthEntryXdrs(prepared)
  const unsignedTxXdr = signRequest.unsignedTxXdr
  const selfCalls = [
    ...(unsignedTxXdr
      ? findSelfAccountCalls({
          accountId: activeAccount.smartAccountAddress,
          txXdr: unsignedTxXdr,
          txSource: 'unsigned',
          networkPassphrase,
        })
      : []),
    ...findSelfAccountCalls({
      accountId: activeAccount.smartAccountAddress,
      txXdr: prepared.txXdr,
      txSource: 'prepared_tx',
      networkPassphrase,
      entriesXdr: entries,
    }),
  ]
  if (!unsignedTxXdr || selfCalls.length > 0) {
    return refuse(
      args.requestId,
      'self_admin_call',
      "This request tries to change your wallet's own settings (signers, rules, or code) or cannot be fully read. Latch only allows that from inside the wallet."
    )
  }

  // Requests stored before the local review existed are reviewed again here.
  const review =
    pending.localReview ??
    assessExternalSignReview({
      unsignedTxXdr,
      preparedTxXdr: prepared.txXdr,
      preparedAuthEntriesXdr: entries,
      networkPassphrase,
      signRequestNetwork: signRequest.network,
      preparedNetwork: prepared.network,
      activeNetwork: await getActiveNetwork(),
      signRequestSmartAccount: signRequest.smartAccountAddress,
      preparedSmartAccount: prepared.smartAccountAddress,
      activeSmartAccount: activeAccount.smartAccountAddress,
      feeForwarderId: feeForwarderContractIdFor(signRequest.network),
    })
  if (review.confirmBlocked) {
    return refuse(
      args.requestId,
      review.code ?? 'review_blocked',
      review.confirmBlockedReason ?? 'This request cannot be signed.'
    )
  }

  await markDappRequestSigning(args.requestId)

  try {
    const submitData = await signAndSubmitBuiltTxInBackground({
      build: prepared,
      activeAccount,
      submit: args.submit,
    })

    const txHash =
      typeof submitData.transactionHash === 'string'
        ? submitData.transactionHash
        : typeof submitData.hash === 'string'
          ? submitData.hash
          : undefined
    const signedTxXdr =
      typeof submitData.signedTxXdr === 'string' ? submitData.signedTxXdr : undefined
    const signedAuthEntry =
      typeof submitData.signedAuthEntry === 'string' ? submitData.signedAuthEntry : undefined

    const origin = await resolvePending({
      requestId: args.requestId,
      approved: true,
      ...(args.submit === false ? { signedTxXdr, signedAuthEntry } : { txHash }),
    })
    if (origin) await closeApprovalWindowForOrigin(origin)

    return { signedTxXdr, signedAuthEntry, txHash, submitData }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await failPending(args.requestId, 'sign_failed', message)
    throw e instanceof Error ? e : new Error(message)
  }
}
