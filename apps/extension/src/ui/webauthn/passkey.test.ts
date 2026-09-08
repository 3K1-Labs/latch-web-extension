import type { StoredAccount } from '@latch/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Encoder } from 'cbor-x'
import { bytesToBase64Url, bytesToHex, concatBytes } from './utils'
import {
  assertBeginOptionsRpIdMatchesCanonicalDomain,
  enrichWebauthnRpIdHashErrorMessage,
  extractRegistrationKeyData,
  formatWebauthnBrowserError,
  getWebauthnCeremonyTypeFromCredential,
  getWebauthnRpIdFromBeginOptions,
  latchWebauthnRpId,
  nextPasskeyAccountDisplayName,
  nextPasskeyRegistrationDisplayName,
  prepareRegistrationOptionsForCreate,
  prepareAuthenticationOptionsForGet,
  prepareDiscoverableAuthenticationOptions,
  readAuthenticatorRpIdHashHexFromCredentialJSON,
  buildWebauthnSigDataXdrHex,
  passkeyAuthenticationOptionsForAuthDigest,
  passkeyAuthenticationOptionsForV1Challenge,
  assertPasskeyAssertionMatchesV1Challenge,
  assertPasskeyAssertionMatchesAuthDigest,
  authDigestChallengeBase64Url,
  toLowSCompactSignatureP256,
} from './passkey'
import { base64UrlToBytes, bytesToBase64Url, hexToBytes } from './utils'
import { DEFAULT_WEBAUTHN_RP_ID } from '../lib/latchEnv'

const CANONICAL_RP = DEFAULT_WEBAUTHN_RP_ID

function account(mode: StoredAccount['mode'], id: string): StoredAccount {
  return { id, mode, smartAccountAddress: 'SADDR', createdAt: 0 }
}

describe('webauthn/passkey', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('nextPasskeyAccountDisplayName is 1-based and counts only passkey accounts', () => {
    expect(nextPasskeyAccountDisplayName([])).toBe('Latch account 1')
    expect(nextPasskeyAccountDisplayName([account('mnemonic', '1'), account('passkey', '2')])).toBe(
      'Latch account 2'
    )
    expect(nextPasskeyAccountDisplayName([account('passkey', '1'), account('passkey', '2')])).toBe(
      'Latch account 3'
    )
  })

  it('latchWebauthnRpId defaults to the shared HTTPS domain', () => {
    expect(latchWebauthnRpId()).toBe(CANONICAL_RP)
  })

  it('getWebauthnRpIdFromBeginOptions reads rp.id or rpId from object or JSON string', () => {
    expect(
      getWebauthnRpIdFromBeginOptions({ rp: { id: 'ext-1', name: 'x' }, challenge: 'c' })
    ).toBe('ext-1')
    expect(getWebauthnRpIdFromBeginOptions({ rpId: 'ext-2', challenge: 'c' })).toBe('ext-2')
    expect(
      getWebauthnRpIdFromBeginOptions(
        JSON.stringify({ rp: { id: 'ext-3', name: 'x' }, challenge: 'c' })
      )
    ).toBe('ext-3')
    expect(getWebauthnRpIdFromBeginOptions(null)).toBeUndefined()
  })

  it('assertBeginOptionsRpIdMatchesCanonicalDomain throws on chrome-extension when rp id mismatches', () => {
    vi.stubGlobal('chrome', { runtime: { id: 'expected-ext' } })
    vi.stubGlobal('window', { location: { protocol: 'chrome-extension:' } })

    expect(() =>
      assertBeginOptionsRpIdMatchesCanonicalDomain({ rp: { id: 'wrong', name: 'n' } })
    ).toThrow(/RP mismatch/)

    expect(() =>
      assertBeginOptionsRpIdMatchesCanonicalDomain({
        rp: { id: CANONICAL_RP, name: 'n' },
      })
    ).not.toThrow()
  })

  it('assertBeginOptionsRpIdMatchesCanonicalDomain is a no-op when not on chrome-extension protocol', () => {
    vi.stubGlobal('chrome', { runtime: { id: 'expected-ext' } })
    vi.stubGlobal('window', { location: { protocol: 'https:' } })

    expect(() =>
      assertBeginOptionsRpIdMatchesCanonicalDomain({ rp: { id: 'wrong', name: 'n' } })
    ).not.toThrow()
  })

  it('formatWebauthnBrowserError surfaces cause for ERROR_INVALID_DOMAIN on chrome-extension', () => {
    vi.stubGlobal('chrome', { runtime: { id: 'ghpalnblflhpeggnlilhhmohbdinlfne' } })
    vi.stubGlobal('window', {
      location: { protocol: 'chrome-extension:' },
    })

    const err = new Error(`${CANONICAL_RP} is an invalid domain`)
    ;(err as { code?: string }).code = 'ERROR_INVALID_DOMAIN'
    err.cause = new Error('SecurityError: The relying party ID is not valid.')

    const msg = formatWebauthnBrowserError(err)
    expect(msg).toContain('Details:')
    expect(msg).toContain(`rp.id to "${CANONICAL_RP}"`)
    expect(msg).toContain(`https://${CANONICAL_RP}/*`)
  })

  it('passkeyAuthenticationOptionsForAuthDigest defaults rpId to the shared domain', () => {
    const digest = '21e5a6e8c3d0940bdd4f01ba07ce73bd5898c8116911d444ed7e4a4b631ee975'
    const opts = passkeyAuthenticationOptionsForAuthDigest({
      credentialId: 'cred-id',
      authDigestHex: digest,
    })
    expect(opts.rpId).toBe(CANONICAL_RP)
    expect(opts.challenge).toBe(bytesToBase64Url(hexToBytes(digest)))
  })

  it('passkeyAuthenticationOptionsForAuthDigest uses auth digest as WebAuthn challenge', () => {
    const digest = '21e5a6e8c3d0940bdd4f01ba07ce73bd5898c8116911d444ed7e4a4b631ee975'
    const opts = passkeyAuthenticationOptionsForAuthDigest({
      credentialId: 'cred-id',
      authDigestHex: digest,
      rpId: CANONICAL_RP,
    })
    expect(opts.rpId).toBe(CANONICAL_RP)
    expect(opts.challenge).toBe(bytesToBase64Url(hexToBytes(digest)))
    expect(base64UrlToBytes(opts.challenge)).toEqual(hexToBytes(digest))
    // No transports filter so synced/hybrid (Google Password Manager) passkeys
    // are not hidden from the signing prompt.
    expect(opts.allowCredentials).toEqual([{ id: 'cred-id', type: 'public-key' }])
    expect(opts).not.toHaveProperty('hints')
  })

  it('passkeyAuthenticationOptionsForV1Challenge uses server nonce as WebAuthn challenge', () => {
    const nonce = '6-UhiL-7gcPsGJ_f0I14haC6vjezQUb7YvSKt-gKyAE'
    const opts = passkeyAuthenticationOptionsForV1Challenge({
      credentialId: 'cred-id',
      challengeBase64Url: nonce,
      rpId: CANONICAL_RP,
    })
    expect(opts.challenge).toBe(nonce)
    expect(opts.rpId).toBe(CANONICAL_RP)
  })

  it('assertPasskeyAssertionMatchesV1Challenge accepts matching nonce', () => {
    const nonce = '6-UhiL-7gcPsGJ_f0I14haC6vjezQUb7YvSKt-gKyAE'
    const clientDataJSON = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: nonce,
          origin: 'chrome-extension://ghpalnblflhpeggnlilhhmohbdinlfne',
        })
      )
    )
    expect(() =>
      assertPasskeyAssertionMatchesV1Challenge(
        { response: { clientDataJSON, authenticatorData: 'aQ', signature: 'c2ln' } },
        nonce
      )
    ).not.toThrow()
  })

  it('assertPasskeyAssertionMatchesAuthDigest rejects login/session challenges', () => {
    const digest = '33b7c86db346aaccdfc355fe37089ba59275211092d85a8253b9a4d22ba7f805'
    const clientDataJSON = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: 'HhoYhoVSBAB0rQ-xSAQ4viG_w9jx_5nKiGUqZeXhtAlA',
          origin: 'chrome-extension://ghpalnblflhpeggnlilhhmohbdinlfne',
        })
      )
    )
    expect(() =>
      assertPasskeyAssertionMatchesAuthDigest(
        { response: { clientDataJSON, authenticatorData: 'aQ', signature: 'c2ln' } },
        digest
      )
    ).toThrow(/wrong challenge/)
  })

  it('assertPasskeyAssertionMatchesAuthDigest accepts matching auth digest challenge', () => {
    const digest = '33b7c86db346aaccdfc355fe37089ba59275211092d85a8253b9a4d22ba7f805'
    const clientDataJSON = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: authDigestChallengeBase64Url(digest),
          origin: 'chrome-extension://ghpalnblflhpeggnlilhhmohbdinlfne',
        })
      )
    )
    expect(() =>
      assertPasskeyAssertionMatchesAuthDigest(
        { response: { clientDataJSON, authenticatorData: 'aQ', signature: 'c2ln' } },
        digest
      )
    ).not.toThrow()
  })

  it('buildWebauthnSigDataXdrHex returns hex XDR', () => {
    const hex = buildWebauthnSigDataXdrHex({
      authenticatorData: new Uint8Array(37),
      clientDataJson: new Uint8Array(20),
      signatureCompact: new Uint8Array(64),
    })
    expect(hex).toMatch(/^[0-9a-f]+$/)
    expect(hex.length).toBeGreaterThan(0)
  })

  it('toLowSCompactSignatureP256 returns 64-byte compact sig (noble/curves v2)', () => {
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])
    const out = toLowSCompactSignatureP256(der)
    expect(out).toHaveLength(64)
    expect(out[31]).toBe(1)
    expect(out[63]).toBe(1)
  })

  it('extractRegistrationKeyData builds keyDataHex = uncompressedPk||credentialIdBytes', () => {
    const encoder = new Encoder()

    const credIdBytes = new Uint8Array([1, 2, 3, 4, 5])
    const x = new Uint8Array(32).fill(0x11)
    const y = new Uint8Array(32).fill(0x22)

    const coseKeyBytes = encoder.encode({ [-2]: x, [-3]: y })

    // rpIdHash(32) || flags(1) || signCount(4) || AAGUID(16) || credIdLen(2) || credId || coseKey
    const flags = 0x40
    const rpIdHash = new Uint8Array(32)
    const signCount = new Uint8Array(4)
    const aaguid = new Uint8Array(16)
    const credIdLen = new Uint8Array([0, credIdBytes.length])

    const authData = concatBytes(
      rpIdHash,
      concatBytes(
        new Uint8Array([flags]),
        concatBytes(
          signCount,
          concatBytes(aaguid, concatBytes(credIdLen, concatBytes(credIdBytes, coseKeyBytes)))
        )
      )
    )

    const attestationObjectBytes = encoder.encode({ authData })
    const registrationResponse = {
      id: 'cred-1',
      response: { attestationObject: bytesToBase64Url(attestationObjectBytes) },
    }

    const res = extractRegistrationKeyData(registrationResponse)
    expect(res.credentialId).toBe('cred-1')
    expect(res.credentialIdBytes).toEqual(credIdBytes)
    expect(res.publicKeyUncompressed).toHaveLength(65)
    expect(res.publicKeyUncompressed[0]).toBe(0x04)

    const expectedKeyDataBytes = concatBytes(res.publicKeyUncompressed, credIdBytes)
    expect(res.keyDataHex).toBe(bytesToHex(expectedKeyDataBytes))
  })

  it('readAuthenticatorRpIdHashHexFromCredentialJSON reads first 32 bytes from authenticatorData', () => {
    const rpIdHash = new Uint8Array(32)
    rpIdHash[0] = 0xab
    rpIdHash[31] = 0xcd
    const authData = concatBytes(rpIdHash, new Uint8Array([0, 0, 0, 0]))
    const cred = { response: { authenticatorData: bytesToBase64Url(authData) } }
    expect(readAuthenticatorRpIdHashHexFromCredentialJSON(cred)).toBe(bytesToHex(rpIdHash))
  })

  it('enrichWebauthnRpIdHashErrorMessage leaves unrelated messages unchanged', async () => {
    expect(await enrichWebauthnRpIdHashErrorMessage('Network error', {})).toBe('Network error')
  })

  it('enrichWebauthnRpIdHashErrorMessage appends expected vs authenticator rpId hashes', async () => {
    const rpId = 'test-extension-id'
    const enc = new TextEncoder()
    const expectedDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(rpId)))
    const expectedHex = bytesToHex(expectedDigest)

    const encoder = new Encoder()
    const credIdBytes = new Uint8Array([1])
    const x = new Uint8Array(32).fill(0x11)
    const y = new Uint8Array(32).fill(0x22)
    const coseKeyBytes = encoder.encode({ [-2]: x, [-3]: y })
    const flags = 0x40
    const authRpIdHash = new Uint8Array(32).fill(0xee)
    const signCount = new Uint8Array(4)
    const aaguid = new Uint8Array(16)
    const credIdLen = new Uint8Array([0, credIdBytes.length])
    const authData = concatBytes(
      authRpIdHash,
      concatBytes(
        new Uint8Array([flags]),
        concatBytes(
          signCount,
          concatBytes(aaguid, concatBytes(credIdLen, concatBytes(credIdBytes, coseKeyBytes)))
        )
      )
    )
    const attestationObjectBytes = encoder.encode({ authData })
    const registrationResponse = {
      id: 'cred-1',
      response: { attestationObject: bytesToBase64Url(attestationObjectBytes) },
    }

    const msg = await enrichWebauthnRpIdHashErrorMessage('Unexpected RP ID hash', {
      optionsJSON: { rp: { id: rpId, name: 'Latch' }, challenge: 'x' },
      credentialResponse: registrationResponse,
    })

    expect(msg).toContain('Unexpected RP ID hash')
    expect(msg).toContain(`"test-extension-id"`)
    expect(msg).toContain(expectedHex)
    expect(msg).toContain(bytesToHex(authRpIdHash))
  })

  it('getWebauthnCeremonyTypeFromCredential reads create vs get from clientDataJSON', () => {
    const createClientData = bytesToBase64Url(
      new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: 'x' }))
    )
    const getClientData = bytesToBase64Url(
      new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: 'y' }))
    )
    expect(
      getWebauthnCeremonyTypeFromCredential({
        response: { clientDataJSON: createClientData, attestationObject: 'x' },
      })
    ).toBe('webauthn.create')
    expect(
      getWebauthnCeremonyTypeFromCredential({
        response: { clientDataJSON: getClientData, authenticatorData: 'a', signature: 's' },
      })
    ).toBe('webauthn.get')
  })

  it('nextPasskeyRegistrationDisplayName adds optional context', () => {
    expect(nextPasskeyRegistrationDisplayName([], 'Team vault')).toBe(
      'Latch account 1 · Team vault'
    )
  })

  it('prepareRegistrationOptionsForCreate requires registration options and preserves server authenticatorSelection', () => {
    const prepared = prepareRegistrationOptionsForCreate({
      challenge: 'c',
      rp: { id: 'ext', name: 'Latch' },
      user: { id: 'u', name: 'n', displayName: 'n' },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: [{ id: 'already-there', type: 'public-key' }],
    }) as Record<string, unknown>
    expect(prepared.rp).toEqual({ id: 'ext', name: 'Latch' })
    const authSel = prepared.authenticatorSelection as {
      residentKey?: string
      authenticatorAttachment?: string
      userVerification?: string
    }
    expect(authSel.residentKey).toBe('preferred')
    expect(authSel.userVerification).toBe('preferred')
    expect(authSel.authenticatorAttachment).toBeUndefined()
    expect(prepared).not.toHaveProperty('excludeCredentials')
    expect(prepared).not.toHaveProperty('hints')
    expect(() => prepareRegistrationOptionsForCreate({ challenge: 'c', rpId: 'ext' })).toThrow(
      /authentication options/
    )
  })

  it('prepareAuthenticationOptionsForGet preserves server transports and does not restrict to internal', () => {
    const prepared = prepareAuthenticationOptionsForGet({
      challenge: 'c',
      rpId: 'ext',
      allowCredentials: [{ id: 'cred-1', type: 'public-key', transports: ['hybrid', 'internal'] }],
    }) as Record<string, unknown>
    expect(prepared).not.toHaveProperty('hints')
    expect(prepared.allowCredentials).toEqual([
      { id: 'cred-1', type: 'public-key', transports: ['hybrid', 'internal'] },
    ])
  })

  it('prepareAuthenticationOptionsForGet omits transports when the server provides none', () => {
    const prepared = prepareAuthenticationOptionsForGet({
      challenge: 'c',
      rpId: 'ext',
      allowCredentials: [{ id: 'cred-1', type: 'public-key' }],
    }) as Record<string, unknown>
    expect(prepared.allowCredentials).toEqual([{ id: 'cred-1', type: 'public-key' }])
  })

  // Login must stay discoverable: a session-scoped allowlist makes Chrome pick a
  // provider itself (iCloud Keychain on macOS) and hides every other passkey for
  // this RP, including ones created in the Latch mobile app.
  it('prepareDiscoverableAuthenticationOptions drops allowCredentials and hints', () => {
    const prepared = prepareDiscoverableAuthenticationOptions({
      challenge: 'c',
      rpId: CANONICAL_RP,
      allowCredentials: [{ id: 'cred-1', type: 'public-key', transports: ['internal'] }],
      hints: ['client-device'],
    }) as Record<string, unknown>
    expect(prepared).not.toHaveProperty('allowCredentials')
    expect(prepared).not.toHaveProperty('hints')
    expect(prepared.rpId).toBe(CANONICAL_RP)
    expect(prepared.challenge).toBe('c')
    expect(prepared.userVerification).toBe('required')
  })

  it('prepareDiscoverableAuthenticationOptions accepts options that carry no allowlist', () => {
    const prepared = prepareDiscoverableAuthenticationOptions({
      challenge: 'c',
      rpId: CANONICAL_RP,
      userVerification: 'preferred',
    }) as Record<string, unknown>
    expect(prepared).not.toHaveProperty('allowCredentials')
    expect(prepared.userVerification).toBe('preferred')
  })

  it('prepareDiscoverableAuthenticationOptions parses a JSON-string begin payload', () => {
    const prepared = prepareDiscoverableAuthenticationOptions(
      JSON.stringify({
        challenge: 'c',
        rpId: CANONICAL_RP,
        allowCredentials: [{ id: 'cred-1', type: 'public-key' }],
      })
    ) as Record<string, unknown>
    expect(prepared).not.toHaveProperty('allowCredentials')
    expect(prepared.rpId).toBe(CANONICAL_RP)
  })

  // Signing pins the active account's credential; only login goes discoverable.
  it('passkeyAuthenticationOptionsForAuthDigest survives discoverable-login changes', () => {
    const digest = '21e5a6e8c3d0940bdd4f01ba07ce73bd5898c8116911d444ed7e4a4b631ee975'
    const signing = prepareAuthenticationOptionsForGet(
      passkeyAuthenticationOptionsForAuthDigest({ credentialId: 'cred-id', authDigestHex: digest })
    ) as Record<string, unknown>
    expect(signing.allowCredentials).toEqual([{ id: 'cred-id', type: 'public-key' }])
  })
})
