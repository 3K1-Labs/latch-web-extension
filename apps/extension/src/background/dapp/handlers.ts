import type {
  BackgroundMessage,
  DappDisconnectRequest,
  DappOpenSignRequestPayload,
  DappPageSessionStartRequest,
  ExternalSignResult,
  GetDappPermissionsRequest,
  ListPendingDappRequestsResponse,
  ResolvePendingDappRequest,
  RunExternalSignFlowRequest,
  SetDappPermissionsRequest,
} from '@latch/types'

import { BackendError } from '../api/client'
import { buildSignRequestSearchParams } from '../externalSign/parseSignRequest'
import { runExternalSignFlow } from '../externalSign/orchestrator'
import type { OkFn } from '../messageResponse'
import {
  addPendingDappRequest,
  clearDappOriginDisconnected,
  clearDappPermissions,
  getAccounts,
  getDappPermissions,
  listPendingDappRequests,
  markDappOriginDisconnected,
  removePendingDappRequest,
  setDappPermissions,
} from '../storage'
import {
  mapExternalSignResultToProviderResponse,
  mergePermissions,
  openApprovalPopup,
  pendingDappResolvers,
  rejectPendingDappRequestsForOrigin,
  requireDappApproval,
  assertDappConnectPromptAllowed,
  closeApprovalWindowForOrigin,
  suppressGrantAccessPrompt,
  waitForExternalSignDecision,
} from './approvalSession'

/** Returns true if the message type was handled. */
export async function tryHandleDappMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
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
      const stored = await listPendingDappRequests()
      // Drop orphans left after SW restart (in-memory waiters are gone).
      const requests = stored.filter((r) => pendingDappResolvers.has(r.id))
      if (requests.length !== stored.length) {
        const liveIds = new Set(requests.map((r) => r.id))
        for (const orphan of stored) {
          if (!liveIds.has(orphan.id)) await removePendingDappRequest(orphan.id)
        }
      }
      const data: ListPendingDappRequestsResponse = { requests }
      sendResponse(ok(data))
      return true
    }

    case 'RESOLVE_PENDING_DAPP_REQUEST': {
      const req = message.payload as ResolvePendingDappRequest
      const resolver = pendingDappResolvers.get(req.requestId)
      pendingDappResolvers.delete(req.requestId)
      // Look up origin before removing so Cancel / dismiss can cooldown + close durable UI.
      const stored = await listPendingDappRequests()
      const pendingRow = stored.find((r) => r.id === req.requestId)
      await removePendingDappRequest(req.requestId)
      if (!req.approved && pendingRow?.kind === 'getPublicKey') {
        suppressGrantAccessPrompt(pendingRow.origin)
      }
      resolver?.({
        approved: req.approved,
        errorMessage: req.errorMessage,
        errorCode: req.errorCode,
        signedXdr: req.signedXdr,
        txHash: req.txHash,
        signedAuthEntry: req.signedAuthEntry,
        signedTxXdr: req.signedTxXdr,
      })
      if (pendingRow?.origin) {
        await closeApprovalWindowForOrigin(pendingRow.origin)
      }
      sendResponse(ok())
      return true
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
      const req = message.payload as GetDappPermissionsRequest
      const allowed = await getDappPermissions(req.origin)
      if (!allowed.includes('getPublicKey')) {
        // After disconnect / dismissed Grant Access, fail closed instead of
        // opening another prompt in a retry loop.
        await assertDappConnectPromptAllowed(req.origin)
        const approval = await requireDappApproval({ origin: req.origin, kind: 'getPublicKey' })
        if (!approval.approved) {
          throw new BackendError(approval.errorMessage ?? 'User rejected', {
            status: 403,
            code: approval.errorCode ?? 'user_rejected',
          })
        }
        await setDappPermissions(req.origin, mergePermissions(allowed, 'getPublicKey'))
      }
      const { accounts, activeAccountId } = await getAccounts()
      const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0]
      if (!active?.smartAccountAddress) {
        throw new BackendError('No active account', { status: 400, code: 'no_account' })
      }
      sendResponse(ok({ publicKey: active.smartAccountAddress }))
      return true
    }

    case 'DAPP_DISCONNECT': {
      const req = message.payload as DappDisconnectRequest
      // Mark sticky first so an in-flight getPublicKey retry cannot race open a prompt.
      await markDappOriginDisconnected(req.origin)
      await clearDappPermissions(req.origin)
      await rejectPendingDappRequestsForOrigin(req.origin)
      sendResponse(ok())
      return true
    }

    case 'DAPP_PAGE_SESSION_START': {
      const req = message.payload as DappPageSessionStartRequest
      await clearDappOriginDisconnected(req.origin)
      sendResponse(ok())
      return true
    }

    case 'DAPP_OPEN_SIGN_REQUEST': {
      const req = message.payload as DappOpenSignRequestPayload
      const allowed = await getDappPermissions(req.origin)
      if (!allowed.includes('getPublicKey')) {
        await assertDappConnectPromptAllowed(req.origin)
        const approval = await requireDappApproval({ origin: req.origin, kind: 'getPublicKey' })
        if (!approval.approved) {
          throw new BackendError(approval.errorMessage ?? 'User rejected', {
            status: 403,
            code: approval.errorCode ?? 'user_rejected',
          })
        }
        await setDappPermissions(req.origin, mergePermissions(allowed, 'getPublicKey'))
      }
      const query = buildSignRequestSearchParams(req.request)
      const url = chrome.runtime.getURL(`tabs/sign-request.html?${query}`)
      await chrome.tabs.create({ url })
      sendResponse(ok())
      return true
    }

    case 'DAPP_SIGN_TRANSACTION': {
      const req = message.payload as {
        origin?: string
        request: {
          xdr: string
          network: 'testnet' | 'mainnet'
          accountToSign: string
          submit?: boolean
        }
      }
      const origin = req.origin ?? 'unknown'
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
        senderUrl: undefined,
        waitForDecision: waitForExternalSignDecision,
        enqueueReview: async (pending) => {
          await addPendingDappRequest(pending)
        },
        openPopup: async () => {
          await openApprovalPopup(origin)
        },
      })

      const response = mapExternalSignResultToProviderResponse(flowResult as ExternalSignResult)
      sendResponse(ok({ response }))
      return true
    }

    default:
      return false
  }
}
