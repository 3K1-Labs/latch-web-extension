/**
 * Background Service Worker — the ONLY execution context that may hold key material.
 *
 * Responsibilities:
 * - Encrypted vault (keys never leave this context)
 * - Transaction signing
 * - Message routing from popup and content scripts
 *
 * Security rule: NEVER send raw private keys in chrome.runtime.sendMessage responses.
 */

import './cleanup-main-injector'
import './actionBehavior'

import type { BackgroundMessage, BackgroundResponse, CancelRequest } from '@latch/types'

import { tryHandleAccountsMessage } from './accounts/handlers'
import { tryHandleConfirmMessage } from './confirm/handlers'
import { initDappApprovalListeners } from './dapp/approvalSession'
import { tryHandleDappMessage } from './dapp/handlers'
import { tryHandleDepositMessage } from './deposit/handlers'
import { ok, toSerializableError } from './messageResponse'
import { tryHandleMigrationMessage } from './migration/handlers'
import { tryHandleMultisigMessage } from './multisig/handlers'
import { tryHandleNetworkMessage } from './network/handlers'
import { tryHandleOnboardingMessage } from './onboarding/handlers'
import { tryHandleReadsMessage } from './reads/handlers'
import { abortRequest } from './requestRegistry'
import { tryHandleSignersMessage } from './signers/handlers'
import { tryHandleSwapMessage } from './swap/handlers'
import { tryHandleTxMessage } from './tx/handlers'
import { tryHandleV1AuthMessage } from './v1Auth/handlers'

initDappApprovalListeners()

chrome.runtime.onMessage.addListener((rawMessage: BackgroundMessage, _sender, sendResponse) => {
  const message = rawMessage as BackgroundMessage

  if (message.type === 'CANCEL_REQUEST') {
    const req = message.payload as CancelRequest
    if (req?.requestId) {
      abortRequest(req.requestId)
    }
    sendResponse(ok(undefined) satisfies BackgroundResponse)
    return false
  }

  ;(async () => {
    if (await tryHandleMultisigMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleV1AuthMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleDepositMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleAccountsMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleSignersMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleConfirmMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleTxMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleReadsMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleSwapMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleMigrationMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleNetworkMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleDappMessage(message, sendResponse, ok)) {
      return
    }
    if (await tryHandleOnboardingMessage(message, sendResponse, ok)) {
      return
    }

    const type = message?.type ?? 'unknown'
    console.warn('[latch:background] unhandled message', type)
    sendResponse({
      ok: false,
      error: {
        message: `Unhandled background message: ${String(type)}`,
        code: 'unhandled_message',
      },
    } satisfies BackgroundResponse)
  })().catch((err) => {
    sendResponse({ ok: false, error: toSerializableError(err) } satisfies BackgroundResponse)
  })

  return true // keep channel open for async responses
})

export {}
