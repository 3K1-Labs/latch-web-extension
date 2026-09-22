/**
 * Public dapp protocol — the only methods an untrusted webpage may request
 * via the content-script bridge. Internal MessageTypes are never accepted
 * from the page; the bridge translates method → MessageType.
 */

import type { MessageType } from '@latch/types'

export const PUBLIC_DAPP_METHODS = [
  'ping',
  'getNetwork',
  'getPublicKey',
  'signTransaction',
  'openSignRequest',
  'disconnect',
] as const

export type PublicDappMethod = (typeof PUBLIC_DAPP_METHODS)[number]

const PUBLIC_METHOD_TO_MESSAGE_TYPE: Record<PublicDappMethod, MessageType> = {
  ping: 'PING_EXTENSION',
  getNetwork: 'GET_ACTIVE_NETWORK',
  getPublicKey: 'DAPP_GET_PUBLIC_KEY',
  signTransaction: 'DAPP_SIGN_TRANSACTION',
  openSignRequest: 'DAPP_OPEN_SIGN_REQUEST',
  disconnect: 'DAPP_DISCONNECT',
}

/** Message types the content script may send (page-mapped + CS-initiated). */
export const CONTENT_SCRIPT_MESSAGE_TYPES = [
  ...Object.values(PUBLIC_METHOD_TO_MESSAGE_TYPE),
  'DAPP_PAGE_SESSION_START',
  'DAPP_POLL_REQUEST_RESULT',
] as const satisfies readonly MessageType[]

export type ContentScriptMessageType = (typeof CONTENT_SCRIPT_MESSAGE_TYPES)[number]

const PUBLIC_METHOD_SET = new Set<string>(PUBLIC_DAPP_METHODS)
const CONTENT_SCRIPT_TYPE_SET = new Set<string>(CONTENT_SCRIPT_MESSAGE_TYPES)

export function isPublicDappMethod(value: unknown): value is PublicDappMethod {
  return typeof value === 'string' && PUBLIC_METHOD_SET.has(value)
}

export function publicMethodToMessageType(method: PublicDappMethod): MessageType {
  return PUBLIC_METHOD_TO_MESSAGE_TYPE[method]
}

export function isContentScriptAllowedMessageType(type: unknown): type is ContentScriptMessageType {
  return typeof type === 'string' && CONTENT_SCRIPT_TYPE_SET.has(type)
}

export function unsupportedProviderError(): { message: string; code: string } {
  return {
    message: 'Unsupported provider method',
    code: 'unsupported_method',
  }
}

/**
 * Overwrite caller-supplied origin fields with the attested page origin so a
 * webpage cannot impersonate another site.
 */
export function pinDappOrigin(payload: unknown, origin: string): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload
  }

  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>), origin }

  const request = next.request
  if (
    request !== null &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    'origin' in (request as Record<string, unknown>)
  ) {
    next.request = {
      ...(request as Record<string, unknown>),
      origin,
    }
  }

  return next
}
