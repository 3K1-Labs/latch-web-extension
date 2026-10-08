/**
 * UI client for the background-owned passkey bridge.
 * Ceremony wait lives in the service worker so action-popup death cannot drop it.
 */

import {
  LATCH_PASSKEY_BRIDGE_RESULT,
  passkeyBridgeResultStorageKey,
  type PasskeyBridgeStoredResult,
} from '../../background/webauthn/passkeyBridge'
import { friendlyError, sendToBackground } from '../lib/backgroundClient'

export {
  LATCH_PASSKEY_BRIDGE_RESULT,
  passkeyBridgeResultStorageKey,
  passkeyBridgeStorageKey,
  type PasskeyBridgeStoredPayload,
  type PasskeyBridgeStoredResult,
} from '../../background/webauthn/passkeyBridge'

export async function openPasskeyBridgeAndWait(args: {
  mode: 'registration' | 'authentication'
  optionsJSON: unknown
  timeoutMs?: number
}): Promise<unknown> {
  const res = await sendToBackground<
    {
      mode: 'registration' | 'authentication'
      optionsJSON: unknown
      timeoutMs?: number
    },
    unknown
  >(
    {
      type: 'RUN_PASSKEY_BRIDGE',
      payload: args,
    },
    // Match the background bridge waiter. A short timeout abandons the ceremony
    // before registration/authentication finish is ever sent.
    args.timeoutMs ?? 120_000
  )
  if (!res.ok) throw new Error(friendlyError(res.error) || 'Passkey bridge failed.')
  return res.data
}

/** Persist ceremony outcome for waiters that missed the runtime message. */
export async function publishPasskeyBridgeResult(args: {
  ticket: string
  ok: boolean
  response?: unknown
  error?: string
}): Promise<void> {
  const resultKey = passkeyBridgeResultStorageKey(args.ticket)
  const stored: PasskeyBridgeStoredResult = {
    ok: args.ok,
    response: args.response,
    error: args.error,
    createdAt: Date.now(),
  }
  await chrome.storage.session.set({ [resultKey]: stored })
  try {
    await chrome.runtime.sendMessage({
      type: LATCH_PASSKEY_BRIDGE_RESULT,
      ticket: args.ticket,
      ok: args.ok,
      response: args.response,
      error: args.error,
    })
  } catch {
    // Parent may already be gone; storage fallback covers that.
  }
}
