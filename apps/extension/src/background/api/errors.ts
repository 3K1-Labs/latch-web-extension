/** Stable code for a request aimed at the other deployment. */
export const DEPLOYMENT_NETWORK_MISMATCH = 'deployment_network_mismatch'

const DEPLOYMENT_NETWORK_MISMATCH_MESSAGE = 'Latch is pointed at the wrong deployment.'

/** User-facing copy for backend codes whose raw message is too technical. */
const API_ERROR_COPY: Record<string, string> = {
  signer_rule_not_found:
    "This passkey isn't a signer on this wallet. Sign in with a passkey that is.",
  network_mismatch: DEPLOYMENT_NETWORK_MISMATCH_MESSAGE,
  NETWORK_MISMATCH: DEPLOYMENT_NETWORK_MISMATCH_MESSAGE,
}

function messageForCode(code: string | undefined, message: string): string {
  if (code && API_ERROR_COPY[code]) return API_ERROR_COPY[code]
  return message
}

function normalizeCode(code: string | undefined): string | undefined {
  if (code === 'network_mismatch' || code === 'NETWORK_MISMATCH') return DEPLOYMENT_NETWORK_MISMATCH
  return code
}

export function parseApiError(status: number, data: unknown): { message: string; code?: string } {
  if (!data || typeof data !== 'object') {
    return { message: `Request failed: ${status}` }
  }

  const body = data as Record<string, unknown>

  // v1 nested: { error: { code, message } }
  if (body.error && typeof body.error === 'object' && body.error !== null) {
    const nested = body.error as Record<string, unknown>
    const message =
      typeof nested.message === 'string' ? nested.message : `Request failed: ${status}`
    const code = typeof nested.code === 'string' ? nested.code : undefined
    return { message: messageForCode(code, message), code: normalizeCode(code) }
  }

  // webapp flat: { error, message, code }
  const message =
    (typeof body.error === 'string' ? body.error : undefined) ??
    (typeof body.message === 'string' ? body.message : undefined) ??
    `Request failed: ${status}`
  const code = typeof body.code === 'string' ? body.code : undefined
  return { message: messageForCode(code, message), code: normalizeCode(code) }
}
