/**
 * Derive dapp authorization identity from Chrome MessageSender, not page payloads.
 *
 * Prefer sender.url (the frame that sent the message) over tab.url so an iframe
 * cannot inherit the parent page's origin.
 */

export type RuntimeSenderLike = {
  origin?: string
  url?: string
  tab?: { id?: number; url?: string }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function invalidOriginError(): { message: string; code: string } {
  return {
    message: 'Missing or unsupported dapp origin',
    code: 'invalid_origin',
  }
}

export function originMismatchError(): { message: string; code: string } {
  return {
    message: 'Payload origin does not match attested sender origin',
    code: 'origin_mismatch',
  }
}

/** True for https: and loopback http: (localhost / 127.0.0.1 / [::1]). */
export function isAllowedDappWebOrigin(origin: string): boolean {
  const trimmed = origin.trim()
  if (!trimmed || trimmed === 'null') return false
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol === 'http:') {
      return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    }
    return false
  } catch {
    return false
  }
}

function originFromUrl(url: string | undefined): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  try {
    const origin = new URL(trimmed).origin
    if (!origin || origin === 'null') return null
    return origin
  } catch {
    return null
  }
}

/**
 * Chrome-attested origin for a webpage / content-script sender.
 * Order: sender.url → sender.tab.url → sender.origin.
 */
export function trustedDappOriginFromSender(sender: RuntimeSenderLike | undefined): string | null {
  if (!sender) return null

  const fromUrl = originFromUrl(sender.url)
  if (fromUrl) return fromUrl

  const fromTab = originFromUrl(sender.tab?.url)
  if (fromTab) return fromTab

  const fromOrigin = sender.origin?.trim()
  if (fromOrigin && fromOrigin !== 'null') return fromOrigin

  return null
}

/**
 * Resolve and validate a trusted dapp origin, or return null when Chrome did not
 * attest a usable https / loopback-http origin.
 */
export function resolveTrustedDappOrigin(sender: RuntimeSenderLike | undefined): string | null {
  const origin = trustedDappOriginFromSender(sender)
  if (!origin || !isAllowedDappWebOrigin(origin)) return null
  return origin
}

/**
 * Assert a trusted dapp origin for content-script flows. Throws with a stable
 * error shape so background handlers can fail closed.
 */
export function assertTrustedDappOrigin(sender: RuntimeSenderLike | undefined): string {
  const origin = resolveTrustedDappOrigin(sender)
  if (!origin) {
    const err = invalidOriginError()
    throw Object.assign(new Error(err.message), { code: err.code })
  }
  return origin
}

/**
 * If the payload still carries an origin, it must match the attested one.
 * Returns an error object when mismatched; undefined when ok or absent.
 */
export function payloadOriginMismatch(
  payload: unknown,
  trustedOrigin: string
): { message: string; code: string } | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined
  }
  const raw = (payload as Record<string, unknown>).origin
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed !== trustedOrigin) return originMismatchError()
  return undefined
}
