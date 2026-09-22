/**
 * Page → bridge request handling (allowlist + translate + pin origin).
 * Kept separate from provider-bridge.ts so unit tests avoid Plasmo `url:` imports.
 */

import type { DappPollRequestResultResponse, MessageType } from '@latch/types'

import {
  isPublicDappMethod,
  pinDappOrigin,
  publicMethodToMessageType,
  unsupportedProviderError,
} from '../dapp/publicDappProtocol'
import { tryParsePublicDappPayload } from '../dapp/publicDappPayload'

export type ProviderBridgeRequest = {
  messageId: number
  method?: unknown
  /** Legacy/internal field — never trusted from the page. */
  type?: unknown
  payload?: unknown
}

type BgRes<T> = { ok: boolean; data?: T; error?: { message: string; code?: string } }

type SendMessageFn = (message: { type: string; payload: unknown }) => Promise<BgRes<unknown>>

const POLL_INTERVAL_MS = 300
const POLL_TIMEOUT_MS = 120_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPendingAck(data: unknown): data is { requestId: string; status: 'awaiting_user' } {
  if (!data || typeof data !== 'object') return false
  const row = data as Record<string, unknown>
  return typeof row.requestId === 'string' && row.status === 'awaiting_user'
}

async function pollDappRequestResult(
  sendMessage: SendMessageFn,
  requestId: string,
  pageOrigin: string
): Promise<BgRes<unknown>> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    let res: BgRes<DappPollRequestResultResponse>
    try {
      res = (await sendMessage({
        type: 'DAPP_POLL_REQUEST_RESULT' satisfies MessageType,
        payload: { requestId, origin: pageOrigin },
      })) as BgRes<DappPollRequestResultResponse>
    } catch (e) {
      // Service worker may be restarting — keep polling until timeout.
      if (Date.now() >= deadline) {
        return {
          ok: false,
          error: {
            message: e instanceof Error ? e.message : String(e),
            code: 'extension_unreachable',
          },
        }
      }
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    if (!res?.ok) {
      // Transient SW miss: retry. Hard errors (not_found after settle) stop.
      const code = res?.error?.code
      if (code === 'not_found' || code === 'validation_error' || code === 'unsupported_method') {
        return res
      }
      if (Date.now() >= deadline) return res
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    const data = res.data
    if (!data) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    if (data.status === 'awaiting_user' || data.status === 'signing') {
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    if (data.status === 'approved') {
      if (typeof data.publicKey === 'string') {
        return { ok: true, data: { publicKey: data.publicKey } }
      }
      if (data.response) {
        return { ok: true, data: { response: data.response } }
      }
      return {
        ok: false,
        error: { message: 'Approved without result payload', code: 'error' },
      }
    }

    return {
      ok: false,
      error: {
        message: data.error?.message ?? 'Request failed',
        code: data.error?.code ?? data.status,
      },
    }
  }

  return {
    ok: false,
    error: { message: 'Latch extension timeout', code: 'timeout' },
  }
}

/**
 * Handle one page → bridge request. Rejects non-public methods and malformed
 * payloads before sendMessage. For connect/sign that need approval, polls until
 * the session-backed request reaches a terminal state.
 */
export async function handleProviderBridgeRequest(
  data: ProviderBridgeRequest,
  opts: {
    pageOrigin: string
    sendMessage: SendMessageFn
  }
): Promise<BgRes<unknown>> {
  if (!isPublicDappMethod(data.method)) {
    return { ok: false, error: unsupportedProviderError() }
  }

  const type = publicMethodToMessageType(data.method)
  const pinned = pinDappOrigin(data.payload, opts.pageOrigin)
  const parsed = tryParsePublicDappPayload(type, pinned)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error }
  }

  try {
    const first = (await opts.sendMessage({
      type,
      payload: parsed.payload,
    })) as BgRes<unknown>

    if (
      first?.ok &&
      isPendingAck(first.data) &&
      (type === 'DAPP_GET_PUBLIC_KEY' || type === 'DAPP_SIGN_TRANSACTION')
    ) {
      return await pollDappRequestResult(opts.sendMessage, first.data.requestId, opts.pageOrigin)
    }

    return first
  } catch (e) {
    return {
      ok: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        code: 'extension_unreachable',
      },
    }
  }
}
