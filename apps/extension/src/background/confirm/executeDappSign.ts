import type { BuildSendTxResponse, ResolvePendingDappRequest, SubmitTxResponse } from '@latch/types'

import { closeApprovalWindowForOrigin, pendingDappResolvers } from '../dapp/approvalSession'
import { getAccounts, listPendingDappRequests, removePendingDappRequest } from '../storage'
import { signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'

async function resolvePending(req: ResolvePendingDappRequest): Promise<string | undefined> {
  const stored = await listPendingDappRequests()
  const origin = stored.find((r) => r.id === req.requestId)?.origin
  const resolver = pendingDappResolvers.get(req.requestId)
  pendingDappResolvers.delete(req.requestId)
  await removePendingDappRequest(req.requestId)
  resolver?.({
    approved: req.approved,
    errorMessage: req.errorMessage,
    errorCode: req.errorCode,
    signedXdr: req.signedXdr,
    txHash: req.txHash,
    signedAuthEntry: req.signedAuthEntry,
    signedTxXdr: req.signedTxXdr,
  })
  return origin
}

export async function executeDappExternalSignInBackground(args: {
  requestId: string
  accountId: string
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

  try {
    const submitData = await signAndSubmitBuiltTxInBackground({
      build: args.prepared,
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
    const origin = await resolvePending({
      requestId: args.requestId,
      approved: false,
      errorMessage: message,
      errorCode: 'sign_failed',
    }).catch(() => undefined)
    if (origin) await closeApprovalWindowForOrigin(origin).catch(() => {})
    throw e instanceof Error ? e : new Error(message)
  }
}
