import type {
  BackgroundMessage,
  DappOpenSignRequestPayload,
  DappPollRequestResultRequest,
  DappPollRequestResultResponse,
  DappSignTransactionRequest,
  ExternalSignResult,
  GetDappPermissionsRequest,
  ListPendingDappRequestsResponse,
  ResolvePendingDappRequest,
  RunExternalSignFlowRequest,
  SetDappPermissionsRequest,
} from '@latch/types'

import { BackendError } from '../api/client'
import { buildSignRequestSearchParams } from '../externalSign/parseSignRequest'
import { decisionToExternalSignResult, runExternalSignFlow } from '../externalSign/orchestrator'
import type { OkFn } from '../messageResponse'
import type { RuntimeSender } from '../messageSource'
import {
  parseDappOpenSignRequestPayload,
  parseDappPollRequestResultPayload,
  parseDappSignTransactionPayload,
  parseOriginOnlyPayload,
  PublicDappPayloadError,
} from '../../dapp/publicDappPayload'
import {
  invalidOriginError,
  payloadOriginMismatch,
  resolveTrustedDappOrigin,
  type RuntimeSenderLike,
} from '../../dapp/trustedOrigin'
import {
  addPendingDappRequest,
  clearDappOriginDisconnected,
  clearDappPermissions,
  getAccounts,
  getDappPermissions,
  markDappOriginDisconnected,
  setDappPermissions,
} from '../storage'
import {
  enqueueDappApproval,
  mapExternalSignResultToProviderResponse,
  mergePermissions,
  openApprovalPopup,
  rejectPendingDappRequestsForOrigin,
  requireDappApproval,
  assertDappConnectPromptAllowed,
  closeApprovalWindowForOrigin,
  suppressGrantAccessPrompt,
  waitForExternalSignDecision,
  resolveDappRequestDecision,
} from './approvalSession'
import { getDappRequest, listLiveDappRequests } from './requestState'

/**
 * Chrome-attested origin for content-script dapp messages. Rejects when the
 * payload still claims a different origin after the gate pin.
 */
function trustedOriginForDappMessage(
  sender: RuntimeSenderLike | undefined,
  payload: unknown
): string {
  const origin = resolveTrustedDappOrigin(sender)
  if (!origin) {
    const err = invalidOriginError()
    throw new BackendError(err.message, { status: 403, code: err.code })
  }
  const mismatch = payloadOriginMismatch(payload, origin)
  if (mismatch) {
    throw new BackendError(mismatch.message, { status: 403, code: mismatch.code })
  }
  return origin
}

function senderUrlFrom(sender: RuntimeSenderLike | undefined): string | undefined {
  const url = sender?.url?.trim() || sender?.tab?.url?.trim()
  return url || undefined
}

function rethrowPayloadValidation(e: unknown): never {
  if (e instanceof PublicDappPayloadError) {
    throw new BackendError(e.message, { status: 400, code: e.code })
  }
  throw e
}

async function activeSmartAccountPublicKey(): Promise<string> {
  const { accounts, activeAccountId } = await getAccounts()
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0]
  if (!active?.smartAccountAddress) {
    throw new BackendError('No active account', { status: 400, code: 'no_account' })
  }
  return active.smartAccountAddress
}

/** Returns true if the message type was handled. */
export async function tryHandleDappMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn,
  sender?: RuntimeSender
): Promise<boolean> {
  switch (message.type) {
    case 'GET_DAPP_PERMISSIONS': {
      const req = message.payload as GetDappPermissionsRequest
      const allowed = await getDappPermissions(req.origin)
      sendResponse(ok({ origin: req.origin, allowed }))
      return true
    }

    case 'SET_DAPP_PERMISSIONS': {
      const req = message.payload as SetDappPermissionsRequest
      const allowed = await setDappPermissions(req.origin, req.allowed)
      sendResponse(ok({ origin: req.origin, allowed }))
      return true
    }

    case 'LIST_PENDING_DAPP_REQUESTS': {
      const requests = await listLiveDappRequests()
      const data: ListPendingDappRequestsResponse = { requests }
      sendResponse(ok(data))
      return true
    }

    case 'RESOLVE_PENDING_DAPP_REQUEST': {
      const req = message.payload as ResolvePendingDappRequest
      const before = await getDappRequest(req.requestId)
      const record = await resolveDappRequestDecision(req)
      const origin = record?.origin ?? before?.origin
      const kind = record?.kind ?? before?.kind
      if (!req.approved && kind === 'getPublicKey' && origin) {
        suppressGrantAccessPrompt(origin)
      }
      if (origin) {
        await closeApprovalWindowForOrigin(origin)
      }
      sendResponse(ok())
      return true
    }

    case 'DAPP_POLL_REQUEST_RESULT': {
      let req: DappPollRequestResultRequest
      try {
        req = parseDappPollRequestResultPayload(message.payload)
      } catch (e) {
        rethrowPayloadValidation(e)
      }
      const origin = trustedOriginForDappMessage(sender, req)
      const record = await getDappRequest(req.requestId)
      if (!record || record.origin !== origin) {
        throw new BackendError('Unknown request', { status: 404, code: 'not_found' })
      }

      if (record.status === 'awaiting_user' || record.status === 'signing') {
        const data: DappPollRequestResultResponse = { status: record.status }
        sendResponse(ok(data))
        return true
      }

      if (record.status === 'expired') {
        const data: DappPollRequestResultResponse = {
          status: 'expired',
          error: {
            message: record.errorMessage ?? 'Request expired',
            code: record.errorCode ?? 'expired',
          },
        }
        sendResponse(ok(data))
        return true
      }

      if (record.status === 'rejected') {
        const data: DappPollRequestResultResponse = {
          status: 'rejected',
          error: {
            message: record.errorMessage ?? 'User rejected',
            code: record.errorCode ?? 'user_rejected',
          },
        }
        sendResponse(ok(data))
        return true
      }

      // approved
      if (record.kind === 'getPublicKey') {
        const allowed = await getDappPermissions(origin)
        if (!allowed.includes('getPublicKey')) {
          await setDappPermissions(origin, mergePermissions(allowed, 'getPublicKey'))
        }
        const publicKey = await activeSmartAccountPublicKey()
        const data: DappPollRequestResultResponse = { status: 'approved', publicKey }
        sendResponse(ok(data))
        return true
      }

      if (record.kind === 'externalSignReview') {
        const signRequest = record.signRequest
        if (!signRequest) {
          throw new BackendError('Missing sign request', { status: 400, code: 'error' })
        }
        const flowResult = decisionToExternalSignResult(signRequest, {
          approved: true,
          txHash: record.txHash,
          signedAuthEntry: record.signedAuthEntry,
          signedTxXdr: record.signedTxXdr,
          signedXdr: record.signedXdr,
        })
        const response = mapExternalSignResultToProviderResponse(flowResult)
        const data: DappPollRequestResultResponse = { status: 'approved', response }
        sendResponse(ok(data))
        return true
      }

      throw new BackendError('Unsupported request kind', { status: 400, code: 'error' })
    }

    case 'PREPARE_EXTERNAL_SIGN': {
      const req = message.payload as RunExternalSignFlowRequest
      const result = await runExternalSignFlow({
        source: 'sign-request-tab',
        request: req.request,
        senderUrl: undefined,
        waitForDecision: waitForExternalSignDecision,
        enqueueReview: async (pending) => {
          await addPendingDappRequest(pending)
        },
      })
      sendResponse(ok(result))
      return true
    }

    case 'RUN_EXTERNAL_SIGN_FLOW': {
      const req = message.payload as RunExternalSignFlowRequest
      if (req.source === 'sign-request-tab') {
        const result = await runExternalSignFlow({
          source: 'sign-request-tab',
          request: req.request,
          waitForDecision: waitForExternalSignDecision,
          enqueueReview: async (pending) => {
            await addPendingDappRequest(pending)
          },
        })
        sendResponse(ok(result))
        return true
      }

      const result = await runExternalSignFlow({
        source: 'provider',
        request: req.request,
        senderUrl: undefined,
        waitForDecision: waitForExternalSignDecision,
        enqueueReview: async (pending) => {
          await addPendingDappRequest(pending)
        },
        openPopup: async () => {
          await openApprovalPopup(req.request.origin)
        },
      })
      sendResponse(ok(result as ExternalSignResult))
      return true
    }

    case 'DAPP_GET_PUBLIC_KEY': {
      let req: GetDappPermissionsRequest
      try {
        req = parseOriginOnlyPayload(message.payload)
      } catch (e) {
        rethrowPayloadValidation(e)
      }
      const origin = trustedOriginForDappMessage(sender, req)
      const allowed = await getDappPermissions(origin)
      if (!allowed.includes('getPublicKey')) {
        await assertDappConnectPromptAllowed(origin)
        const { requestId } = await enqueueDappApproval({ origin, kind: 'getPublicKey' })
        sendResponse(ok({ requestId, status: 'awaiting_user' as const }))
        return true
      }
      const publicKey = await activeSmartAccountPublicKey()
      sendResponse(ok({ publicKey }))
      return true
    }

    case 'DAPP_DISCONNECT': {
      let req: GetDappPermissionsRequest
      try {
        req = parseOriginOnlyPayload(message.payload)
      } catch (e) {
        rethrowPayloadValidation(e)
      }
      const origin = trustedOriginForDappMessage(sender, req)
      // Mark sticky first so an in-flight getPublicKey retry cannot race open a prompt.
      await markDappOriginDisconnected(origin)
      await clearDappPermissions(origin)
      await rejectPendingDappRequestsForOrigin(origin)
      sendResponse(ok())
      return true
    }

    case 'DAPP_PAGE_SESSION_START': {
      let req: GetDappPermissionsRequest
      try {
        req = parseOriginOnlyPayload(message.payload)
      } catch (e) {
        rethrowPayloadValidation(e)
      }
      const origin = trustedOriginForDappMessage(sender, req)
      await clearDappOriginDisconnected(origin)
      sendResponse(ok())
      return true
    }

    case 'DAPP_OPEN_SIGN_REQUEST': {
      let req: DappOpenSignRequestPayload
      try {
        req = parseDappOpenSignRequestPayload(message.payload)
      } catch (e) {
        rethrowPayloadValidation(e)
      }
      const origin = trustedOriginForDappMessage(sender, req)
      const allowed = await getDappPermissions(origin)
      if (!allowed.includes('getPublicKey')) {
        await assertDappConnectPromptAllowed(origin)
        const approval = await requireDappApproval({ origin, kind: 'getPublicKey' })
        if (!approval.approved) {
          throw new BackendError(approval.errorMessage ?? 'User rejected', {
            status: 403,
            code: approval.errorCode ?? 'user_rejected',
          })
        }
        await setDappPermissions(origin, mergePermissions(allowed, 'getPublicKey'))
      }
      // Bind nested request.origin to the attested site for the sign-request tab.
      const request = { ...req.request, origin }
      const query = buildSignRequestSearchParams(request)
      const url = chrome.runtime.getURL(`tabs/sign-request.html?${query}`)
      await chrome.tabs.create({ url })
      sendResponse(ok())
      return true
    }

    case 'DAPP_SIGN_TRANSACTION': {
      let req: DappSignTransactionRequest
      try {
        req = parseDappSignTransactionPayload(message.payload)
      } catch (e) {
        rethrowPayloadValidation(e)
      }
      const origin = trustedOriginForDappMessage(sender, req)
      const allowed = await getDappPermissions(origin)
      if (!allowed.includes('getPublicKey')) {
        throw new BackendError('Site not connected — call getPublicKey first', {
          status: 403,
          code: 'not_connected',
        })
      }

      const flowResult = await runExternalSignFlow({
        source: 'provider',
        request: {
          network: req.request.network,
          smartAccountAddress: req.request.accountToSign,
          unsignedTxXdr: req.request.xdr,
          origin,
          submit: req.request.submit !== false,
        },
        senderUrl: senderUrlFrom(sender),
        waitForDecision: waitForExternalSignDecision,
        enqueueReview: async (pending) => {
          await addPendingDappRequest(pending)
        },
        openPopup: async () => {
          await openApprovalPopup(origin)
        },
        awaitDecision: false,
      })

      if ('pending' in flowResult && flowResult.pending) {
        sendResponse(ok({ requestId: flowResult.requestId, status: 'awaiting_user' as const }))
        return true
      }

      // Prepare failed before enqueue — map error result to provider error.
      if ('status' in flowResult) {
        const response = mapExternalSignResultToProviderResponse(flowResult as ExternalSignResult)
        sendResponse(ok({ response }))
        return true
      }

      throw new BackendError('Unexpected sign flow result', { status: 500, code: 'error' })
    }

    default:
      return false
  }
}
