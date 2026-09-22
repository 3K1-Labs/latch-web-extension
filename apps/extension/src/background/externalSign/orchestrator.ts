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
import {
  contextSetupErrShape,
  contextSetupKey,
  ensureSendRulesConfigured,
  ensureSwapRulesConfigured,
  withInflightContextSetup,
} from '../tx/ensureContextRules'
import { isNoContextRuleError, isPrepareSignMissingSetupError } from '../../ui/lib/sendTx'
import { isOriginAllowedForSigning } from './allowList'
import { assertAllowedCallbackUrl } from './callbackUrl'
import { resolveExternalSignContextSetup } from './contextRuleSetup'

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

/**
 * Prefer Chrome-attested senderUrl when present (provider / content-script path).
 * Fall back to request.origin for sign-request-tab / UI-prepared sessions where
 * senderUrl must stay unset so chrome-extension:// is not treated as the dapp.
 */
function resolveOrigin(request: ExternalSignRequest, senderUrl?: string): string {
  if (senderUrl) {
    try {
      const origin = new URL(senderUrl).origin
      if (origin && origin !== 'null') return origin
    } catch {
      // fall through
    }
  }
  if (request.origin?.trim()) return request.origin.trim()
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

type PrepareSignArgs = Parameters<typeof prepareSign>[0]

async function runContextRuleSetup(args: {
  unsignedTxXdr: string
  network: ExternalSignRequest['network']
  account: StoredAccount
}): Promise<'configured' | 'already_configured'> {
  const setup = resolveExternalSignContextSetup({
    unsignedTxXdr: args.unsignedTxXdr,
    network: args.network,
    account: args.account,
  })
  const key = contextSetupKey({
    network: args.network,
    smartAccountAddress: args.account.smartAccountAddress!,
    kind: setup.kind,
    target: setup.target,
  })

  try {
    return await withInflightContextSetup(key, () =>
      setup.kind === 'send'
        ? ensureSendRulesConfigured({ setupBody: setup.body, activeAccount: args.account })
        : ensureSwapRulesConfigured({ setupBody: setup.body, activeAccount: args.account })
    )
  } catch (e) {
    if (e instanceof BackendError) throw e
    throw new BackendError(e instanceof Error ? e.message : String(e), {
      status: 400,
      code: 'context_rule_setup_failed',
    })
  }
}

/**
 * prepare-sign fails closed when the smart account has no context rule for the
 * contract the dapp wants to call. Send and swap confirm already recover by
 * running one-time setup and retrying, so mirror that here — otherwise a cold
 * account can never reach review. Setup itself may need several transactions
 * (`remainingSetupCount`), but prepare-sign is attempted at most twice.
 */
async function prepareSignWithContextRuleRecovery(args: {
  prepareArgs: PrepareSignArgs
  unsignedTxXdr: string
  network: ExternalSignRequest['network']
  account: StoredAccount
}): Promise<PrepareSignResponse> {
  try {
    return await prepareSign(args.prepareArgs)
  } catch (e) {
    const shape = contextSetupErrShape(e)
    if (!isPrepareSignMissingSetupError(shape)) throw e

    const setupResult = await runContextRuleSetup({
      unsignedTxXdr: args.unsignedTxXdr,
      network: args.network,
      account: args.account,
    })
    // An opaque 400 is not proof of missing rules: if nothing needed setting up,
    // the original failure was something else and retrying would hide it.
    if (setupResult === 'already_configured' && !isNoContextRuleError(shape)) throw e

    return await prepareSign(args.prepareArgs)
  }
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
  const prepared = await prepareSignWithContextRuleRecovery({
    prepareArgs: {
      network: signRequest.network,
      smartAccountAddress: signRequest.smartAccountAddress,
      unsignedTxXdr,
      signerType,
      signerG: active.gAddress,
    },
    unsignedTxXdr,
    network: signRequest.network,
    account: active,
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
    status: 'awaiting_user',
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
  /**
   * When false, enqueue the review UI and return `{ pending: true, requestId }`
   * without awaiting the user (provider path + CS poll). Default true.
   */
  awaitDecision?: boolean
}): Promise<
  ExternalSignResult | RunExternalSignFlowPreparedResponse | { pending: true; requestId: string }
> {
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

    // Register optional same-generation waiter before durable enqueue.
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

    if (args.awaitDecision === false) {
      return { pending: true, requestId: pending.id }
    }

    const decision = await decisionPromise
    return decisionToExternalSignResult(session.signRequest, decision)
  } catch (err) {
    return backendErrorToExternalSignResult(err, signRequest)
  }
}
