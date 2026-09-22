/**
 * Page → bridge request handling (allowlist + translate + pin origin).
 * Kept separate from provider-bridge.ts so unit tests avoid Plasmo `url:` imports.
 */

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

/**
 * Handle one page → bridge request. Rejects non-public methods and malformed
 * payloads before sendMessage.
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
    return (await opts.sendMessage({
      type,
      payload: parsed.payload,
    })) as BgRes<unknown>
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
