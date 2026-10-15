import type { SerializableError } from '@latch/types'

/** Known empty factory C-address (diagnostic note only — no repair/rewrite here). */
const KNOWN_DISPLACED_FACTORY = 'CCATLEKRXNV7OXJ2OD3BHFVAZG4A2KRS6VPSD7BO6KTBL6YHX5MESRJ5'

function isKnownDisplacedFactoryAddress(address: string): boolean {
  return address.trim() === KNOWN_DISPLACED_FACTORY
}

export type FormatFundErrorOptions = {
  /** Smart-account / V1 wallet address when known (diagnostic only). */
  wallet?: string
}

/**
 * Cause-specific Fund / V1-auth error copy. Prefer this over attributing every
 * UNAUTHORIZED to WEBAUTHN_ALLOWED_ORIGINS alone.
 */
export function formatFundError(e?: SerializableError, opts?: FormatFundErrorOptions): string {
  if (!e) return 'Unknown error'

  const code = (e.code ?? '').trim()
  const message = typeof e.message === 'string' ? e.message.trim() : ''

  if (
    code === 'deployment_network_mismatch' ||
    code === 'NETWORK_MISMATCH' ||
    code === 'network_mismatch' ||
    /issued a .+ challenge while the wallet is on/i.test(message)
  ) {
    return 'Latch is pointed at the wrong deployment.'
  }

  if (code === 'moonpay_network_mismatch') {
    return (
      message ||
      'MoonPay live keys cannot be used while the wallet is on testnet. Use a sandbox key or switch to mainnet.'
    )
  }

  if (code === 'moonpay_unsigned_url') {
    return (
      message ||
      'MoonPay did not return a signed widget URL. Funding cannot open an unsigned live buy link.'
    )
  }

  if (code === 'transak_missing_widget_url') {
    return (
      message ||
      'Transak did not return a widget URL. The Latch API must create a Transak session and return widget_url.'
    )
  }

  if (code === 'transak_crypto_required') {
    return message || 'Choose XLM or USDC before opening Transak.'
  }

  if (code === 'fund_provider_conflict') {
    return message || 'Choose a single on-ramp provider.'
  }

  if (
    code === 'INTERNAL_ERROR' ||
    code === 'internal_error' ||
    (/^internal error$/i.test(message) && (e.status === 500 || !e.status))
  ) {
    return (
      'Funding is temporarily unavailable (Latch funding service / relayer error). ' +
      'This is not a passkey problem — try again shortly, or use Receive from another wallet.'
    )
  }

  if (code === 'UNAUTHORIZED' || /signature verification failed/i.test(message)) {
    const extId =
      typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : '<extension-id>'
    let out =
      (message || 'Signature verification failed') +
      ' Likely causes, in order: (1) the API verified your passkey against the wrong Stellar network, ' +
      '(2) this smart account is not deployed / has no WebAuthn signer on the active network, ' +
      `(3) origin chrome-extension://${extId} is missing from the V1 wallet-auth allowlist.`
    if (opts?.wallet && isKnownDisplacedFactoryAddress(opts.wallet)) {
      out +=
        ' Note: this wallet address looks like a known empty factory C-address — Fund may fail until the funded smart account address is restored.'
    }
    return out
  }

  if (code === 'V1_AUTH_REQUIRED') return 'Sign in required to continue.'
  if (code === 'fund_unsupported_mode') {
    return 'Fund via on-ramp is not available for this account type yet.'
  }
  if (code === 'timeout') return 'Request timed out. Please try again.'

  return message || 'Unknown error'
}
