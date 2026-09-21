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

type RuntimeSender = {
  id?: string
  origin?: string
  url?: string
  tab?: { id?: number }
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
 * For those messages, pin payload.origin to Chrome's attested sender.origin.
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

  const pageOrigin = sender?.origin?.trim()
  if (!pageOrigin || pageOrigin === 'null') {
    // CS without an attested origin — still allow type, but do not invent origin.
    return { allowed: true, message }
  }

  return {
    allowed: true,
    message: {
      type: message.type as MessageType,
      payload: pinDappOrigin(message.payload, pageOrigin),
    },
  }
}
