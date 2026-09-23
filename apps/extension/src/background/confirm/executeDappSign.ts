import type { BuildSendTxResponse, ResolvePendingDappRequest, SubmitTxResponse } from '@latch/types'

import { closeApprovalWindowForOrigin, resolveDappRequestDecision } from '../dapp/approvalSession'
import { markDappRequestSigning } from '../dapp/requestState'
import { getAccounts } from '../storage'
import { signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'

async function resolvePending(req: ResolvePendingDappRequest): Promise<string | undefined> {
  const record = await resolveDappRequestDecision(req)
  return record?.origin
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

  await markDappRequestSigning(args.requestId)

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
