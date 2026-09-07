import type {
  ExternalSignLocalReview,
  ExternalSignRequest,
  ExternalSignResult,
  ExternalSignSource,
  PendingDappRequest,
  PrepareSignResponse,
  RunExternalSignFlowPreparedResponse,
  SendSignerType,
  StoredAccount,
} from '@latch/types'
import { assessExternalSignReview } from '@latch/stellar'

import { BackendError, fetchSignPayload, prepareSign } from '../backend'
import { getActiveNetwork, networkPassphraseFor } from '../network/config'
import { getAccounts } from '../storage'
import { isOriginAllowedForSigning } from './allowList'
import { assertAllowedCallbackUrl } from './callbackUrl'

export type ExternalSignDecision = {
  approved: boolean
  /** When approved is false and set, maps to ExternalSignResult status "error". */
  errorMessage?: string
  errorCode?: string
  txHash?: string
  signedAuthEntry?: string
  signedTxXdr?: string
  signedXdr?: string
}

export type WaitForExternalSignDecision = (requestId: string) => Promise<ExternalSignDecision>

function accountModeToSignerType(account: StoredAccount): SendSignerType {
  // 'freighter' is the backend wire value for delegated G-signer builds (mnemonic accounts).
  return account.mode === 'passkey' ? 'passkey' : 'freighter'
}

function resolveOrigin(request: ExternalSignRequest, senderUrl?: string): string {
  if (request.origin?.trim()) return request.origin.trim()
  if (senderUrl) {
    try {
      return new URL(senderUrl).origin
    } catch {
      // fall through
    }
  }
  return 'unknown'
}

async function resolveUnsignedXdr(
  request: ExternalSignRequest
): Promise<{ unsignedTxXdr: string; signRequest: ExternalSignRequest }> {
  if (request.unsignedTxXdr?.trim()) {
    return { unsignedTxXdr: request.unsignedTxXdr.trim(), signRequest: request }
  }
  if (!request.payloadRef?.trim()) {
    throw new BackendError('Missing unsigned transaction XDR', { code: 'validation_error' })
  }

  const stored = await fetchSignPayload(request.payloadRef.trim())
  if (request.callback && stored.callback !== request.callback) {
    throw new BackendError('Callback URL mismatch for payload reference', {
      code: 'validation_error',
    })
  }
  if (request.network && stored.network !== request.network) {
    throw new BackendError('Network mismatch for payload reference', { code: 'validation_error' })
  }
  if (request.smartAccountAddress && stored.smartAccountAddress !== request.smartAccountAddress) {
    throw new BackendError('Account mismatch for payload reference', { code: 'account_mismatch' })
  }

  const signRequest: ExternalSignRequest = {
    network: stored.network,
    smartAccountAddress: stored.smartAccountAddress,
    unsignedTxXdr: stored.unsignedTxXdr,
    callback: stored.callback ?? request.callback,
    requestId: stored.requestId ?? request.requestId,
    origin: stored.origin ?? request.origin,
    submit: stored.submit ?? request.submit,
    payloadRef: request.payloadRef,
  }
  return { unsignedTxXdr: stored.unsignedTxXdr, signRequest }
}

async function getActiveAccountOrThrow(): Promise<StoredAccount> {
  const { accounts, activeAccountId } = await getAccounts()
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0]
  if (!active?.smartAccountAddress) {
    throw new BackendError('No active account', { status: 400, code: 'no_account' })
  }
  return active
}

export async function prepareExternalSignSession(args: {
  source: ExternalSignSource
  request: ExternalSignRequest
  senderUrl?: string
  skipAllowlist?: boolean
}): Promise<{
  origin: string
  signRequest: ExternalSignRequest
  prepared: PrepareSignResponse
  localReview: ExternalSignLocalReview
}> {
  const origin = resolveOrigin(args.request, args.senderUrl)

  if (args.source === 'provider' && !args.skipAllowlist) {
    const allowed = await isOriginAllowedForSigning(origin)
    if (!allowed) {
      throw new BackendError('Site not connected', { status: 403, code: 'not_connected' })
    }
  }

  if (args.request.callback) {
    assertAllowedCallbackUrl(args.request.callback)
  }

  const { unsignedTxXdr, signRequest } = await resolveUnsignedXdr(args.request)
  const active = await getActiveAccountOrThrow()

  if (signRequest.smartAccountAddress !== active.smartAccountAddress) {
    throw new BackendError('Transaction account does not match active wallet account', {
      code: 'account_mismatch',
    })
  }

  const signerType = accountModeToSignerType(active)
  const prepared = await prepareSign({
    network: signRequest.network,
    smartAccountAddress: signRequest.smartAccountAddress,
    unsignedTxXdr,
    signerType,
    signerG: active.gAddress,
  })

  const activeNetwork = await getActiveNetwork()
  const localReview = assessExternalSignReview({
    unsignedTxXdr,
    preparedTxXdr: prepared.txXdr,
    networkPassphrase: networkPassphraseFor(signRequest.network),
    signRequestNetwork: signRequest.network,
    preparedNetwork: prepared.network,
    activeNetwork,
    signRequestSmartAccount: signRequest.smartAccountAddress,
    preparedSmartAccount: prepared.smartAccountAddress,
    activeSmartAccount: active.smartAccountAddress,
  })

  return { origin, signRequest, prepared, localReview }
}

export function buildPendingExternalSignRequest(args: {
  origin: string
  signRequest: ExternalSignRequest
  prepared: PrepareSignResponse
  localReview: ExternalSignLocalReview
  source: ExternalSignSource
}): PendingDappRequest {
  return {
    id: crypto.randomUUID(),
    origin: args.origin,
    kind: 'externalSignReview',
    createdAt: Date.now(),
    signRequest: args.signRequest,
    prepared: args.prepared,
    localReview: args.localReview,
    source: args.source,
  }
}

export function decisionToExternalSignResult(
  signRequest: ExternalSignRequest,
  decision: ExternalSignDecision
): ExternalSignResult {
  if (!decision.approved) {
    if (decision.errorMessage) {
      return {
        status: 'error',
        code: decision.errorCode ?? 'error',
        message: decision.errorMessage,
        requestId: signRequest.requestId,
        network: signRequest.network,
      }
    }
    return {
      status: 'rejected',
      code: 'user_rejected',
      message: 'User rejected',
      requestId: signRequest.requestId,
      network: signRequest.network,
    }
  }

  const submit = signRequest.submit !== false
  if (submit) {
    if (!decision.txHash) {
      return {
        status: 'error',
        code: 'no_tx_hash',
        message: 'Signing completed without transaction hash',
        requestId: signRequest.requestId,
        network: signRequest.network,
      }
    }
    return {
      status: 'signed',
      txHash: decision.txHash,
      requestId: signRequest.requestId,
      network: signRequest.network,
    }
  }

  return {
    status: 'signed',
    signedAuthEntry: decision.signedAuthEntry,
    signedTxXdr: decision.signedTxXdr ?? decision.signedXdr,
    requestId: signRequest.requestId,
    network: signRequest.network,
  }
}

export function backendErrorToExternalSignResult(
  err: unknown,
  signRequest?: ExternalSignRequest
): ExternalSignResult {
  if (err instanceof BackendError) {
    return {
      status: 'error',
      code: err.code ?? 'error',
      message: err.message,
      requestId: signRequest?.requestId,
      network: signRequest?.network,
    }
  }
  return {
    status: 'error',
    code: 'error',
    message: err instanceof Error ? err.message : String(err),
    requestId: signRequest?.requestId,
    network: signRequest?.network,
  }
}

export async function runExternalSignFlow(args: {
  source: ExternalSignSource
  request: ExternalSignRequest
  senderUrl?: string
  waitForDecision: WaitForExternalSignDecision
  enqueueReview: (pending: PendingDappRequest) => Promise<void>
  openPopup?: () => Promise<void>
}): Promise<ExternalSignResult | RunExternalSignFlowPreparedResponse> {
  let signRequest = args.request
  try {
    const session = await prepareExternalSignSession({
      source: args.source,
      request: args.request,
      senderUrl: args.senderUrl,
    })
    signRequest = session.signRequest

    const pending = buildPendingExternalSignRequest({
      origin: session.origin,
      signRequest: session.signRequest,
      prepared: session.prepared,
      localReview: session.localReview,
      source: args.source,
    })

    // Register waiter before durable enqueue so LIST cannot treat this as an orphan.
    const decisionPromise = args.waitForDecision(pending.id)
    await args.enqueueReview(pending)

    if (args.source === 'sign-request-tab') {
      return {
        requestId: pending.id,
        origin: session.origin,
        signRequest: session.signRequest,
        prepared: session.prepared,
        localReview: session.localReview,
      }
    }

    if (args.openPopup) {
      await args.openPopup()
    }

    const decision = await decisionPromise
    return decisionToExternalSignResult(session.signRequest, decision)
  } catch (err) {
    return backendErrorToExternalSignResult(err, signRequest)
  }
}
