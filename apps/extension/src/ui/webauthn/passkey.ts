import type { StoredAccount } from '@latch/types'
import { p256 } from '@noble/curves/nist.js'
import { decodeMultiple } from 'cbor-x'
import { xdr } from '@stellar/stellar-sdk'

import { latchWebauthnRpId } from '../lib/latchEnv'
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, concatBytes, hexToBytes } from './utils'

export { latchWebauthnRpId } from '../lib/latchEnv'

/** WebAuthn `user.displayName` for the next passkey registration (1-based, counts existing local passkey accounts). */
export function nextPasskeyAccountDisplayName(accounts: StoredAccount[]): string {
  const passkeyCount = accounts.reduce((n, a) => n + (a.mode === 'passkey' ? 1 : 0), 0)
  return `Latch account ${passkeyCount + 1}`
}

/** Unique WebAuthn display name for a new passkey in a specific flow (e.g. multisig). */
export function nextPasskeyRegistrationDisplayName(
  accounts: StoredAccount[],
  context?: string
): string {
  const base = nextPasskeyAccountDisplayName(accounts)
  const ctx = context?.trim()
  return ctx ? `${base} · ${ctx}` : base
}

export type PasskeyRegistrationResult = {
  credentialId: string
  credentialIdBytes: Uint8Array
  publicKeyUncompressed: Uint8Array // 65 bytes, 0x04 || x || y
  keyDataHex: string
}

export type PasskeyAssertionResult = {
  authenticatorData: Uint8Array
  clientDataJson: Uint8Array
  signatureCompact: Uint8Array // 64 bytes r||s low-S
  sigDataXdrHex: string
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function ensureLen(bytes: Uint8Array, len: number, label: string) {
  if (bytes.length !== len) throw new Error(`${label} must be ${len} bytes`)
}

function decodeFirstCborItem(bytes: Uint8Array): unknown {
  // cbor-x decodeMultiple lets us parse the first item even if there are trailing bytes
  for (const item of decodeMultiple(bytes)) return item
  throw new Error('Failed to decode CBOR')
}

function parseAttestationObject(attestationObjectB64Url: string): {
  authData: Uint8Array
} {
  const bytes = base64UrlToBytes(attestationObjectB64Url)
  const obj = decodeFirstCborItem(bytes) as any
  const authData = obj?.authData
  if (!(authData instanceof Uint8Array)) throw new Error('Invalid attestationObject.authData')
  return { authData }
}

function coseToUncompressedP256(coseKey: any): Uint8Array {
  // COSE_Key fields: -2 => x, -3 => y
  const x = coseKey?.[-2]
  const y = coseKey?.[-3]
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array))
    throw new Error('Invalid COSE key (missing x/y)')
  ensureLen(x, 32, 'P-256 x')
  ensureLen(y, 32, 'P-256 y')
  return concatBytes(new Uint8Array([0x04]), concatBytes(x, y))
}

export function extractRegistrationKeyData(registrationResponse: any): PasskeyRegistrationResult {
  const attObj = registrationResponse?.response?.attestationObject
  const credentialId = registrationResponse?.id
  if (typeof attObj !== 'string') throw new Error('Missing attestationObject')
  if (typeof credentialId !== 'string') throw new Error('Missing credential id')

  const { authData } = parseAttestationObject(attObj)

  // authenticatorData layout:
  // rpIdHash(32) || flags(1) || signCount(4) || attestedCredentialData(if flags&0x40) ...
  const flags = authData[32]
  const hasAttestedCredData = (flags & 0x40) !== 0
  if (!hasAttestedCredData) throw new Error('Attested credential data missing in authenticatorData')

  let offset = 32 + 1 + 4
  offset += 16 // AAGUID
  const credIdLen = readUint16BE(authData, offset)
  offset += 2
  const credentialIdBytes = authData.slice(offset, offset + credIdLen)
  offset += credIdLen

  const coseBytes = authData.slice(offset)
  const coseKey = decodeFirstCborItem(coseBytes)
  const publicKeyUncompressed = coseToUncompressedP256(coseKey)

  const keyDataBytes = concatBytes(publicKeyUncompressed, credentialIdBytes)
  const keyDataHex = bytesToHex(keyDataBytes)

  return { credentialId, credentialIdBytes, publicKeyUncompressed, keyDataHex }
}

function derToRs(der: Uint8Array): { r: bigint; s: bigint } {
  // Minimal ASN.1 DER parser for ECDSA signature: SEQUENCE(INTEGER r, INTEGER s)
  let i = 0
  const expect = (v: number) => {
    if (der[i] !== v) throw new Error('Invalid DER signature')
    i++
  }
  const readLen = () => {
    const b = der[i++]
    if (b < 0x80) return b
    const n = b & 0x7f
    let len = 0
    for (let k = 0; k < n; k++) len = (len << 8) | der[i++]
    return len
  }
  const readInt = (): bigint => {
    expect(0x02)
    const len = readLen()
    const bytes = der.slice(i, i + len)
    i += len
    // remove leading 0x00
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    let x = 0n
    for (const b of bytes.slice(start)) x = (x << 8n) | BigInt(b)
    return x
  }

  expect(0x30)
  readLen()
  const r = readInt()
  const s = readInt()
  return { r, s }
}

function bigintTo32Bytes(x: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = x
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** Scalar field order n for P-256 (noble/curves v2: use `Point.Fn.ORDER`, not `CURVE.n`). */
const P256_ORDER = p256.Point.Fn.ORDER

export function toLowSCompactSignatureP256(derSignature: Uint8Array): Uint8Array {
  const { r, s } = derToRs(derSignature)
  const lowS = s > P256_ORDER / 2n ? P256_ORDER - s : s
  const rBytes = bigintTo32Bytes(r)
  const sBytes = bigintTo32Bytes(lowS)
  return concatBytes(rBytes, sBytes)
}

export function buildWebauthnSigDataXdrHex(args: {
  authenticatorData: Uint8Array
  clientDataJson: Uint8Array
  signatureCompact: Uint8Array
}): string {
  const entries = [
    ['authenticator_data', args.authenticatorData],
    ['client_data', args.clientDataJson],
    ['signature', args.signatureCompact],
  ].map(
    ([k, v]) =>
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(k),
        val: xdr.ScVal.scvBytes(v as Uint8Array),
      })
  )

  const scVal = xdr.ScVal.scvMap(entries)
  const raw = scVal.toXDR() as unknown as Uint8Array
  return bytesToHex(raw instanceof Uint8Array ? raw : new Uint8Array(raw as any))
}

/**
 * Normalize an `allowCredentials` list without restricting which transports the
 * browser may use.
 *
 * We intentionally do NOT force `transports: ['internal']` here. Latch passkeys
 * are frequently stored in Google Password Manager and sync across devices, so
 * they advertise `hybrid` (and other) transports. Forcing `internal` made Chrome
 * filter those out and report "no passkey available" even though the user has
 * Latch passkeys. Server-provided transports are preserved as-is; when none are
 * provided we omit the field so the browser can surface every matching credential
 * for this RP (platform AND synced/hybrid).
 */
function normalizeAllowCredentials(allow: unknown): unknown[] {
  if (!Array.isArray(allow) || allow.length === 0) return []
  return allow.map((cred) => {
    if (!cred || typeof cred !== 'object') return cred
    const c = cred as Record<string, unknown>
    const out: Record<string, unknown> = { ...c, type: c.type ?? 'public-key' }
    if (!Array.isArray(c.transports) || (c.transports as unknown[]).length === 0) {
      delete out.transports
    }
    return out
  })
}

export function createLocalAuthenticationOptions(args: {
  rpId: string
  credentialId: string
  authDigestHex: string
}) {
  const challenge = hexToBytes(args.authDigestHex)
  return {
    rpId: args.rpId,
    challenge: bytesToBase64Url(challenge),
    // No `transports` filter: allow platform + synced/hybrid (Google Password
    // Manager) credentials so signing finds the passkey wherever it is stored.
    allowCredentials: [
      {
        id: args.credentialId,
        type: 'public-key',
      },
    ],
    timeout: 60_000,
    userVerification: 'required',
  } as const
}

/**
 * @deprecated Use {@link latchWebauthnRpId}. Passkeys use the shared HTTPS domain RP ID,
 * not chrome.runtime.id. Kept as an alias so older call sites resolve during the cutover.
 */
export function extensionWebauthnRpId(): string {
  return latchWebauthnRpId()
}

/**
 * WebAuthn options for signing a smart-account auth entry.
 * Challenge must be the build response `authDigestHex` (not PASSKEY_AUTH_BEGIN session challenge).
 */
export function normalizeAuthDigestHex(authDigestHex: string): string {
  const hex = authDigestHex.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Invalid auth digest from transaction build.')
  }
  return hex
}

export function authDigestChallengeBase64Url(authDigestHex: string): string {
  return bytesToBase64Url(hexToBytes(normalizeAuthDigestHex(authDigestHex)))
}

export function challengeBase64UrlFromWebauthnAssertion(assertion: unknown): string | undefined {
  const resp = (assertion as { response?: { clientDataJSON?: unknown } } | null)?.response
  if (!resp || typeof resp !== 'object') return undefined
  const clientDataJSON = (resp as { clientDataJSON?: unknown }).clientDataJSON
  if (typeof clientDataJSON !== 'string' || !clientDataJSON) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(clientDataJSON))) as {
      challenge?: unknown
    }
    return typeof parsed.challenge === 'string' ? parsed.challenge : undefined
  } catch {
    return undefined
  }
}

/**
 * Ensures the passkey signed this transaction's auth digest (not a login/session challenge).
 */
export function assertPasskeyAssertionMatchesAuthDigest(
  assertion: unknown,
  authDigestHex: string
): void {
  const expected = authDigestChallengeBase64Url(authDigestHex)
  const signed = challengeBase64UrlFromWebauthnAssertion(assertion)
  if (!signed) {
    throw new Error('Passkey response did not include a WebAuthn challenge.')
  }
  if (signed !== expected) {
    throw new Error(
      'Passkey signed the wrong challenge for this transaction. ' +
        'Complete only the passkey prompt opened from Send or Swap, then try again.'
    )
  }
  const ceremony = getWebauthnCeremonyTypeFromCredential(assertion)
  if (ceremony === 'webauthn.create') {
    throw new Error('Passkey registration was used instead of signing this transaction.')
  }
}

export function passkeyAuthenticationOptionsForAuthDigest(args: {
  credentialId: string
  authDigestHex: string
  rpId?: string
}) {
  const hex = normalizeAuthDigestHex(args.authDigestHex)
  return createLocalAuthenticationOptions({
    rpId: args.rpId ?? latchWebauthnRpId(),
    credentialId: args.credentialId,
    authDigestHex: hex,
  })
}

/** WebAuthn options for `/v1/auth/challenge` wallet sign-in (nonce is already base64url). */
export function passkeyAuthenticationOptionsForV1Challenge(args: {
  credentialId: string
  challengeBase64Url: string
  rpId?: string
}) {
  const challenge = args.challengeBase64Url.trim()
  if (!challenge) throw new Error('V1 auth challenge missing nonce')
  return {
    rpId: args.rpId ?? latchWebauthnRpId(),
    challenge,
    allowCredentials: [
      {
        id: args.credentialId,
        type: 'public-key',
      },
    ],
    timeout: 60_000,
    userVerification: 'required',
  } as const
}

export function assertPasskeyAssertionMatchesV1Challenge(
  assertion: unknown,
  challengeBase64Url: string
): void {
  const expected = challengeBase64Url.trim()
  const signed = challengeBase64UrlFromWebauthnAssertion(assertion)
  if (!signed) {
    throw new Error('Passkey response did not include a WebAuthn challenge.')
  }
  if (signed !== expected) {
    throw new Error('Passkey signed the wrong V1 auth challenge. Try again.')
  }
}

export function buildPasskeySigDataXdrFromAssertion(assertion: unknown): string {
  const parsed = parseAuthenticationResponse(assertion)
  return buildWebauthnSigDataXdrHex({
    authenticatorData: parsed.authenticatorData,
    clientDataJson: parsed.clientDataJson,
    signatureCompact: parsed.signatureCompact,
  })
}

export function parseAuthenticationResponse(
  authResponse: any
): Omit<PasskeyAssertionResult, 'sigDataXdrHex'> {
  const resp = authResponse?.response
  const authenticatorData = base64UrlToBytes(resp?.authenticatorData)
  const clientDataJson = base64UrlToBytes(resp?.clientDataJSON)
  const signatureDer = base64UrlToBytes(resp?.signature)
  const signatureCompact = toLowSCompactSignatureP256(signatureDer)
  return { authenticatorData, clientDataJson, signatureCompact }
}

function readErrorCauseMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message
  if (
    cause &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof (cause as { message: unknown }).message === 'string'
  ) {
    return (cause as { message: string }).message
  }
  return undefined
}

/**
 * Maps @simplewebauthn/browser start errors to clearer text on extension pages.
 * `ERROR_INVALID_DOMAIN` often masks the real SecurityError in `cause`.
 */
/** Parse begin `options` whether the API returns an object or a JSON string. */
export function webauthnBeginOptionsToObject(options: unknown): Record<string, unknown> | null {
  if (options == null) return null
  if (typeof options === 'string') {
    try {
      const o = JSON.parse(options) as unknown
      if (typeof o === 'object' && o !== null && !Array.isArray(o))
        return o as Record<string, unknown>
      return null
    } catch {
      return null
    }
  }
  if (typeof options === 'object' && !Array.isArray(options))
    return options as Record<string, unknown>
  return null
}

/**
 * Reads rp.id (registration) or rpId (authentication) from WebAuthn begin options.
 */
export function getWebauthnRpIdFromBeginOptions(options: unknown): string | undefined {
  const o = webauthnBeginOptionsToObject(options)
  if (!o) return undefined
  const rp = o.rp as { id?: unknown } | undefined
  if (rp && typeof rp.id === 'string' && rp.id.trim() !== '') return rp.id
  if (typeof o.rpId === 'string' && o.rpId.trim() !== '') return o.rpId
  return undefined
}

/** Restrict authentication begin options to one passkey when the user picked it in the UI. */
export function narrowAuthenticationOptionsToCredential(
  options: unknown,
  credentialId: string
): unknown {
  const o = webauthnBeginOptionsToObject(options)
  if (!o) return options

  const allow = o.allowCredentials
  if (!Array.isArray(allow) || allow.length === 0) {
    return {
      ...o,
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
    }
  }

  const narrowed = allow.filter((cred) => {
    if (!cred || typeof cred !== 'object') return false
    const id = (cred as { id?: unknown }).id
    return id === credentialId
  })

  return {
    ...o,
    allowCredentials:
      narrowed.length > 0
        ? normalizeAllowCredentials(narrowed)
        : [{ id: credentialId, type: 'public-key' }],
  }
}

/**
 * Ensures server-issued options use the shared HTTPS-domain RP ID
 * (`latchWebauthnRpId()`, e.g. uselatch.app), not the Chrome extension id.
 * No-op when not on a chrome-extension page (e.g. unit tests without extension globals).
 */
export function assertBeginOptionsRpIdMatchesCanonicalDomain(options: unknown): void {
  const protocol = typeof window !== 'undefined' ? window.location.protocol : ''
  if (protocol !== 'chrome-extension:') return

  const expected = latchWebauthnRpId()
  const rpId = getWebauthnRpIdFromBeginOptions(options)
  if (rpId === undefined) {
    throw new Error(
      [
        'WebAuthn options from the server are missing rp.id (registration) or rpId (authentication).',
        `The Latch API must set rp.id / rpId to the shared domain "${expected}" (WEBAUTHN_RP_ID).`,
        'chromeExtensionId is only an origin hint (chrome-extension://…), not the RP ID.',
      ].join(' ')
    )
  }
  if (rpId !== expected) {
    throw new Error(
      [
        `WebAuthn RP mismatch: the server set rp.id/rpId to "${rpId}" but Latch expects "${expected}".`,
        'Registration/authentication will fail. Fix the API to always set rp.id to WEBAUTHN_RP_ID',
        '(not chromeExtensionId). See LATCH_BACKEND_DOMAIN_WEBAUTHN_RPID.md.',
      ].join(' ')
    )
  }
}

/** @deprecated Use {@link assertBeginOptionsRpIdMatchesCanonicalDomain}. */
export function assertBeginOptionsRpIdMatchesExtension(options: unknown): void {
  assertBeginOptionsRpIdMatchesCanonicalDomain(options)
}

export function formatWebauthnBrowserError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)

  const code = (err as { code?: string }).code
  const causeMsg = readErrorCauseMessage((err as { cause?: unknown }).cause)
  const protocol = typeof window !== 'undefined' ? window.location.protocol : ''

  if (code === 'ERROR_INVALID_DOMAIN' && protocol === 'chrome-extension:') {
    const rpId = latchWebauthnRpId()
    const parts = [
      'WebAuthn failed in the extension.',
      causeMsg ? `Details: ${causeMsg}` : undefined,
      `The Latch API must set WebAuthn rp.id to "${rpId}" (shared HTTPS domain).`,
      `This extension needs host permission for https://${rpId}/* so Chrome can claim that RP ID.`,
      'chromeExtensionId is only used so the API can allowlist origin chrome-extension://<id>.',
    ].filter(Boolean)
    return parts.join(' ')
  }

  const combined = `${err.message} ${causeMsg ?? ''}`.toLowerCase()
  if (
    code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' ||
    combined.includes('previously registered') ||
    combined.includes('excludecredentials')
  ) {
    return (
      'This device already has a Latch passkey registered. ' +
      'Try again to create another account passkey, or use “Existing passkey” to sign in with one you already have.'
    )
  }

  if (causeMsg) return `${err.message} (${causeMsg})`
  return err.message
}

/** SimpleWebAuthn server throws this when `authenticatorData` rpIdHash does not match any expected RP ID (SHA-256). */
const UNEXPECTED_RP_ID_HASH_RE = /unexpected\s+rp\s*id\s*hash/i

async function sha256HexUtf8(rpId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId))
  return bytesToHex(new Uint8Array(digest))
}

/**
 * Reads the first 32 bytes of `authenticatorData` (WebAuthn rpIdHash) from a credential returned by
 * `startRegistration` / `startAuthentication` (JSON shape).
 */
export function readAuthenticatorRpIdHashHexFromCredentialJSON(credential: unknown): string | null {
  const resp = (credential as { response?: unknown } | null)?.response
  if (!resp || typeof resp !== 'object') return null
  const r = resp as Record<string, unknown>
  try {
    if (typeof r.authenticatorData === 'string' && r.authenticatorData.length > 0) {
      const d = base64UrlToBytes(r.authenticatorData)
      if (d.length < 32) return null
      return bytesToHex(d.subarray(0, 32))
    }
    if (typeof r.attestationObject === 'string') {
      const { authData } = parseAttestationObject(r.attestationObject)
      if (authData.length < 32) return null
      return bytesToHex(authData.subarray(0, 32))
    }
  } catch {
    return null
  }
  return null
}

/**
 * When the Latch API returns SimpleWebAuthn's `Unexpected RP ID hash`, append local diagnostics:
 * rpId from begin options, SHA-256(rpId) as the verifier expects, and rpIdHash from the credential's authData.
 */
export async function enrichWebauthnRpIdHashErrorMessage(
  message: string,
  ctx: { optionsJSON?: unknown; credentialResponse?: unknown }
): Promise<string> {
  if (!UNEXPECTED_RP_ID_HASH_RE.test(message)) return message

  const parts: string[] = [message]
  const rpId =
    ctx.optionsJSON !== undefined ? getWebauthnRpIdFromBeginOptions(ctx.optionsJSON) : undefined

  if (rpId) {
    parts.push(`Begin rp.id/rpId: ${JSON.stringify(rpId)}`)
    parts.push(`SHA-256(rpId) expected by verifier (hex): ${await sha256HexUtf8(rpId)}`)
  } else {
    parts.push('Begin options did not include rp.id or rpId (could not compute expected hash).')
  }

  const fromCred =
    ctx.credentialResponse != null
      ? readAuthenticatorRpIdHashHexFromCredentialJSON(ctx.credentialResponse)
      : null
  if (fromCred) {
    parts.push(`Authenticator rpIdHash from this credential (hex): ${fromCred}`)
  } else {
    parts.push(
      'Could not read rpIdHash from the WebAuthn credential (missing or invalid authenticatorData).'
    )
  }

  const canonical = latchWebauthnRpId()
  parts.push(`Canonical Latch RP ID: ${JSON.stringify(canonical)}`)
  parts.push(`SHA-256(canonical RP ID) (hex): ${await sha256HexUtf8(canonical)}`)

  const extId =
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime?.id === 'string' &&
    chrome.runtime.id.length > 0
      ? chrome.runtime.id
      : undefined
  if (extId) {
    parts.push(
      `This extension origin: chrome-extension://${extId} (not the RP ID; used for expectedOrigin only)`
    )
  }

  return parts.join(' ')
}

export type WebauthnCeremonyType = 'webauthn.create' | 'webauthn.get' | 'unknown'

/** Reads `type` from credential `clientDataJSON` (create vs get). */
export function getWebauthnCeremonyTypeFromCredential(credential: unknown): WebauthnCeremonyType {
  const resp = (credential as { response?: unknown } | null)?.response
  if (!resp || typeof resp !== 'object') return 'unknown'
  const clientDataJSON = (resp as { clientDataJSON?: unknown }).clientDataJSON
  if (typeof clientDataJSON !== 'string' || !clientDataJSON) return 'unknown'
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(clientDataJSON))) as {
      type?: unknown
    }
    if (parsed.type === 'webauthn.create' || parsed.type === 'webauthn.get') {
      return parsed.type
    }
  } catch {
    // ignore
  }
  return 'unknown'
}

export function isRegistrationBeginOptions(options: unknown): boolean {
  const o = webauthnBeginOptionsToObject(options)
  if (!o) return false
  return Array.isArray(o.pubKeyCredParams) && o.user != null && typeof o.user === 'object'
}

/**
 * Surface (non-fatally) when server-issued registration options ignore the
 * unique display name we requested.
 *
 * Google Password Manager and other authenticators label a passkey using
 * `user.displayName` / `user.name`. If the Latch API ignores the `displayName`
 * we send on begin and hardcodes something like "Latch User", every passkey
 * collapses to the same label and becomes impossible to tell apart. We warn
 * loudly (instead of silently mislabeling) rather than throwing, because the
 * name is cosmetic and blocking passkey creation over it would be worse UX. The
 * real fix is server-side (see the WebAuthn backend contract): map the requested
 * `displayName` onto `user.displayName` and a unique `user.name`.
 */
export function warnIfBeginOptionsIgnoreDisplayName(
  options: unknown,
  requestedDisplayName: string | undefined
): void {
  const requested = requestedDisplayName?.trim()
  if (!requested) return
  const o = webauthnBeginOptionsToObject(options)
  const user = o?.user as { displayName?: unknown; name?: unknown } | undefined
  if (!user || typeof user !== 'object') return
  const serverDisplayName = typeof user.displayName === 'string' ? user.displayName : undefined
  if (serverDisplayName !== undefined && serverDisplayName !== requested) {
    console.warn(
      `[latch/passkey] The Latch API ignored the requested passkey display name. ` +
        `Requested "${requested}" but options carry user.displayName "${serverDisplayName}". ` +
        `New passkeys may all show the same label in Google Password Manager until the API maps ` +
        `displayName -> user.displayName / user.name.`
    )
  }
}

/**
 * Validate server begin options for `startRegistration` (do not mutate RP/user/challenge).
 *
 * Do NOT force `authenticatorAttachment: 'platform'` or `residentKey: 'required'`.
 * Those overrides caused Chrome to hang / show no passkey UI for Google Password
 * Manager and other non-platform authenticators — same class of bug as forcing
 * `transports: ['internal']` on authentication. Preserve server
 * `authenticatorSelection` and only fill missing `userVerification`.
 *
 * Strip `excludeCredentials`: when the Latch API lists existing session credentials
 * here, Chrome/platform authenticators throw InvalidStateError
 * ("authenticator was previously registered") and refuse to create another passkey
 * on the same device. Latch intentionally supports multiple passkeys per install
 * (unique WebAuthn user.id per enrollment); excludeCredentials blocks that.
 */
export function prepareRegistrationOptionsForCreate(
  options: unknown,
  requestedDisplayName?: string
): unknown {
  const o = webauthnBeginOptionsToObject(options)
  if (!o) return options
  if (!isRegistrationBeginOptions(o)) {
    throw new Error(
      'Server returned authentication options instead of registration options. Try again or use “I have a wallet” → Existing passkey.'
    )
  }
  warnIfBeginOptionsIgnoreDisplayName(o, requestedDisplayName)
  const authSel =
    o.authenticatorSelection != null && typeof o.authenticatorSelection === 'object'
      ? (o.authenticatorSelection as Record<string, unknown>)
      : {}
  const rest = { ...o }
  delete rest.excludeCredentials
  return {
    ...rest,
    authenticatorSelection: {
      ...authSel,
      userVerification: authSel.userVerification ?? 'preferred',
    },
  }
}

export function assertRegistrationCeremonyForFinish(credential: unknown): void {
  const ceremony = getWebauthnCeremonyTypeFromCredential(credential)
  if (ceremony === 'webauthn.get') {
    throw new Error(
      'You signed in with an existing passkey instead of creating a new one. Use “I have a wallet” → Existing passkey.'
    )
  }
  const inner = (credential as { response?: Record<string, unknown> } | null)?.response
  if (!inner || typeof inner.attestationObject !== 'string' || !inner.attestationObject) {
    throw new Error(
      'Passkey creation did not return a registration attestation. Try again or use “I have a wallet” → Existing passkey.'
    )
  }
}

/** Normalize server begin options for `startAuthentication`. */
export function prepareAuthenticationOptionsForGet(options: unknown): unknown {
  const o = webauthnBeginOptionsToObject(options)
  if (!o) return options
  const rpId = getWebauthnRpIdFromBeginOptions(o)
  const out: Record<string, unknown> = {
    ...o,
    userVerification: o.userVerification ?? 'required',
  }
  if (rpId) out.rpId = rpId
  if (Array.isArray(o.allowCredentials) && o.allowCredentials.length > 0) {
    out.allowCredentials = normalizeAllowCredentials(o.allowCredentials)
  }
  return out
}

/**
 * Normalize server begin options for a **discoverable** `startAuthentication`
 * ("use existing passkey" / login), dropping `allowCredentials` and `hints`.
 *
 * `/api/webauthn/authentication/begin` allowlists only the credentials of the
 * current cookie session. A non-empty list means "these ids only": Chrome then
 * hands the ceremony straight to whichever provider holds one (iCloud Keychain
 * on macOS) instead of offering the provider chooser, and every other passkey
 * for this RP — Google Password Manager, one created in the Latch mobile app —
 * is filtered out even though the API can still complete it (the Latch API's
 * authentication finish adopts credentials it only knows from the shared
 * passkey index). Omitting the field is what makes the OS sheet the picker.
 *
 * Login only. Signing / approve / v1 auth must keep their pinned single-id
 * `allowCredentials` so the prompt resolves the active account's passkey — use
 * {@link prepareAuthenticationOptionsForGet} there.
 */
export function prepareDiscoverableAuthenticationOptions(options: unknown): unknown {
  const prepared = prepareAuthenticationOptionsForGet(options)
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) return prepared
  const out = { ...(prepared as Record<string, unknown>) }
  delete out.allowCredentials
  delete out.hints
  return out
}
