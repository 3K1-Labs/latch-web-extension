/**
 * Classify chrome.runtime.onMessage senders so content scripts cannot invoke
 * wallet-internal MessageTypes. Extension UI (popup, side panel, tabs) keeps
 * the full protocol.
 */

import type { BackgroundMessage, MessageType } from '@latch/types'

import {
  isContentScriptAllowedMessageType,
  pinDappOrigin,
  unsupportedProviderError,
} from '../dapp/publicDappProtocol'
import { tryParsePublicDappPayload } from '../dapp/publicDappPayload'
import {
  invalidOriginError,
  resolveTrustedDappOrigin,
  type RuntimeSenderLike,
} from '../dapp/trustedOrigin'

export type RuntimeSender = RuntimeSenderLike & {
  id?: string
}

function extensionOrigin(): string {
  return `chrome-extension://${chrome.runtime.id}`
}

/**
 * True when the sender is an extension page (popup, side panel, sign-request tab,
 * passkey bridge, etc.) — not a content script on a website.
 */
export function isExtensionUiSender(sender: RuntimeSender | undefined): boolean {
  if (!sender) return false
  if (sender.id !== chrome.runtime.id) return false

  const origin = sender.origin?.trim()
  if (origin) {
    return origin === extensionOrigin()
  }

  const url = sender.url?.trim()
  if (url) {
    return url.startsWith(`${extensionOrigin()}/`) || url === extensionOrigin()
  }

  // Extension contexts sometimes omit origin/url (e.g. service worker self-messages).
  // Content scripts always have a tab with a non-extension URL when origin/url missing
  // would be unusual; prefer fail-closed for tabbed non-extension senders.
  if (sender.tab) return false
  return true
}

export type MessageGateResult =
  | { allowed: true; message: BackgroundMessage }
  | { allowed: false; error: { message: string; code: string } }

/**
 * Content-script / webpage senders may only use CONTENT_SCRIPT_MESSAGE_TYPES.
 * For those messages, pin payload.origin to Chrome's attested sender URL origin
 * (https / loopback http only). Missing or disallowed origins fail closed.
 */
export function gateBackgroundMessage(
  message: BackgroundMessage,
  sender: RuntimeSender | undefined
): MessageGateResult {
  if (isExtensionUiSender(sender)) {
    return { allowed: true, message }
  }

  if (!isContentScriptAllowedMessageType(message.type)) {
    return { allowed: false, error: unsupportedProviderError() }
  }

  const trustedOrigin = resolveTrustedDappOrigin(sender)
  if (!trustedOrigin) {
    return { allowed: false, error: invalidOriginError() }
  }

  const pinned = pinDappOrigin(message.payload, trustedOrigin)
  const parsed = tryParsePublicDappPayload(message.type, pinned)
  if (!parsed.ok) {
    return { allowed: false, error: parsed.error }
  }

  return {
    allowed: true,
    message: {
      type: message.type as MessageType,
      payload: parsed.payload,
    },
  }
}
