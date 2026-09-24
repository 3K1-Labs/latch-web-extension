import type {
  BackgroundMessage,
  BackgroundResponse,
  CancelRequest,
  SerializableError,
} from '@latch/types'

export async function sendToBackground<TPayload, TData>(
  message: BackgroundMessage<TPayload>
): Promise<BackgroundResponse<TData>> {
  return (await chrome.runtime.sendMessage(message)) as BackgroundResponse<TData>
}

/** Detach an in-flight background waiter without aborting shared Horizon/RPC work. */
export async function cancelBackgroundRequest(requestId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'CANCEL_REQUEST',
      payload: { requestId } satisfies CancelRequest,
    } satisfies BackgroundMessage<CancelRequest>)
  } catch {
    // Extension context invalidated or SW suspended — safe to ignore.
  }
}

export function friendlyError(e?: SerializableError): string {
  if (!e) return 'Unknown error'
  if (e.code === 'cancelled') return ''
  if (e.code === 'timeout') return 'Request timed out. Please try again.'
  if (e.code === 'unhandled_message') {
    return 'Extension background is out of date. Reload Latch on chrome://extensions and try again.'
  }
  if (e.code === 'V1_AUTH_REQUIRED') return 'Sign in required to continue.'
  if (e.code === 'fund_unsupported_mode') {
    return 'Fund via on-ramp is not available for this account type yet.'
  }
  if (e.code === 'network_mismatch') {
    return (
      e.message ||
      'The Latch API challenge network does not match your active wallet network. Switch network or try again.'
    )
  }
  if (e.code === 'moonpay_network_mismatch') {
    return (
      e.message ||
      'MoonPay live keys cannot be used while the wallet is on testnet. Use a sandbox key or switch to mainnet.'
    )
  }
  if (e.code === 'moonpay_unsigned_url') {
    return (
      e.message ||
      'MoonPay did not return a signed widget URL. Funding cannot open an unsigned live buy link.'
    )
  }
  if (typeof e.message === 'string' && /failed to build setup transaction/i.test(e.message)) {
    return 'Could not set up send rules. Your smart account may not be deployed on this network yet — try again after the account finishes deploying.'
  }
  if (e.status === 403) return 'Not authorized.'
  if (e.code === 'mnemonic_locked') {
    return 'Seed signer is not loaded. Unlock with your saved password or re-import your recovery phrase.'
  }
  if (
    (e.code === 'internal_error' || e.code === 'INTERNAL_ERROR') &&
    typeof e.message === 'string' &&
    /^internal error$/i.test(e.message.trim())
  ) {
    return (
      'The Latch API returned an internal error. This is usually a backend configuration issue ' +
      '(funding relayer, Soroban RPC, or deploy funding on Render). Try again shortly.'
    )
  }
  const message = typeof e.message === 'string' ? e.message.trim() : ''
  return message || 'Something went wrong. Please try again.'
}

/** Structured console error for paths that must not toast on every prefetch miss. */
export function logLatchError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[latch:${scope}]`, message || error)
}
