import type { Network } from '@latch/types'

/** Default shared WebAuthn RP ID (hostname only). Overridable via PLASMO_PUBLIC_WEBAUTHN_RP_ID. */
export const DEFAULT_WEBAUTHN_RP_ID = 'uselatch.app'

/**
 * Normalize a WebAuthn RP ID / origin-ish string to a bare hostname.
 * Accepts `uselatch.app` or `https://uselatch.app/` — never a path or port.
 */
export function normalizeWebauthnRpId(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`
    const { hostname } = new URL(withScheme)
    return hostname.toLowerCase()
  } catch {
    return trimmed
      .replace(/^https?:\/\//i, '')
      .split('/')[0]!
      .split(':')[0]!
      .trim()
      .toLowerCase()
  }
}

/**
 * Canonical HTTPS-domain WebAuthn RP ID for Latch (extension + web + future native).
 * Not the Chrome extension id — that is only used as clientDataJSON.origin.
 */
export function latchWebauthnRpId(): string {
  const fromEnv = process.env.PLASMO_PUBLIC_WEBAUTHN_RP_ID as string | undefined
  const normalized =
    typeof fromEnv === 'string' && fromEnv.trim() !== ''
      ? normalizeWebauthnRpId(fromEnv)
      : DEFAULT_WEBAUTHN_RP_ID
  return normalized || DEFAULT_WEBAUTHN_RP_ID
}

/** Plasmo inlines `process.env.PLASMO_PUBLIC_*` at build time. */
export function webauthnVerifierAddressFromEnv(network: Network = 'testnet'): string | undefined {
  if (network === 'mainnet') {
    const mainnet = process.env.PLASMO_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS_MAINNET as
      | string
      | undefined
    if (typeof mainnet === 'string' && mainnet.trim() !== '') return mainnet.trim()
    // Never fall back to the testnet verifier on mainnet — that contract is not deployed
    // on public, and setup-send-rules fails with a generic "failed to build setup transaction".
    return undefined
  }
  const raw = process.env.PLASMO_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS as string | undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
