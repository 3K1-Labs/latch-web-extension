import type {
  BackendWebauthnAuthenticationFinishRequest,
  BackendWebauthnAuthenticationFinishResponse,
  BackendWebauthnBeginResponse,
  BackendWebauthnRegistrationFinishRequest,
  BackendWebauthnRegistrationFinishResponse,
} from '@latch/types'

import { latchApiBaseUrl } from './config'
import { latchFetchAbsoluteWithResponse } from './client'
import { normalizeWebauthnCredentialForApi } from './webauthnCredential'
import {
  captureSid,
  clearWebauthnSession,
  persistWebauthnCeremony,
  webauthnSessionCookieHeader,
} from './webauthnSession'
import { withActiveNetwork } from './withActiveNetwork'

/**
 * When set, tells the Latch API this ceremony runs from `chrome-extension://<id>`
 * (clientDataJSON.origin). RP ID is always the shared HTTPS domain (WEBAUTHN_RP_ID), not this value.
 */
function chromeExtensionIdForWebauthn(): string | undefined {
  try {
    if (
      typeof chrome !== 'undefined' &&
      typeof chrome.runtime?.id === 'string' &&
      chrome.runtime.id.length > 0
    ) {
      return chrome.runtime.id
    }
  } catch {
    // ignore
  }
  return undefined
}

function chromeExtensionHeaders(): Record<string, string> {
  const id = chromeExtensionIdForWebauthn()
  return id ? { 'X-Latch-Chrome-Extension-Id': id } : {}
}

export function webauthnBeginBody(extra: Record<string, unknown> = {}): string {
  const id = chromeExtensionIdForWebauthn()
  return JSON.stringify({
    ...extra,
    ...(id ? { chromeExtensionId: id } : {}),
  })
}

/** JSON body for transaction submit routes that accept optional `chromeExtensionId`. */
export function latchExtensionJsonBody(payload: object): string {
  const id = chromeExtensionIdForWebauthn()
  return JSON.stringify({
    ...payload,
    ...(id ? { chromeExtensionId: id } : {}),
  })
}

export async function webauthnFinishBody(
  payload: object,
  ceremony: 'registration' | 'authentication'
): Promise<string> {
  const id = chromeExtensionIdForWebauthn()
  const body = payload as Record<string, unknown>
  const response = body.response
  const normalizedResponse =
    response != null ? normalizeWebauthnCredentialForApi(response, ceremony) : response
  const withNet = await withActiveNetwork(body)

  return JSON.stringify({
    ...withNet,
    ...(normalizedResponse != null ? { response: normalizedResponse } : {}),
    ...(id ? { chromeExtensionId: id } : {}),
  })
}

function challengeFromBeginOptions(options: unknown): string | undefined {
  if (!options || typeof options !== 'object') return undefined
  const challenge = (options as { challenge?: unknown }).challenge
  return typeof challenge === 'string' && challenge.trim() !== '' ? challenge : undefined
}

async function passkeyBegin(
  path: string,
  kind: 'registration' | 'authentication',
  extra: Record<string, unknown> = {}
): Promise<BackendWebauthnBeginResponse> {
  const baseUrl = latchApiBaseUrl()
  const { res, data } = await latchFetchAbsoluteWithResponse<BackendWebauthnBeginResponse>(
    `${baseUrl}${path}`,
    {
      method: 'POST',
      body: webauthnBeginBody(extra),
      headers: chromeExtensionHeaders(),
    }
  )
  const sid = await captureSid(baseUrl, res)
  await persistWebauthnCeremony(kind, {
    sid,
    challenge: challengeFromBeginOptions(data?.options),
  })
  return data
}

async function passkeyFinish<TRes>(
  path: string,
  kind: 'registration' | 'authentication',
  req: object
): Promise<TRes> {
  const baseUrl = latchApiBaseUrl()
  const cookieHeaders = await webauthnSessionCookieHeader(kind)
  try {
    const { res, data } = await latchFetchAbsoluteWithResponse<TRes>(`${baseUrl}${path}`, {
      method: 'POST',
      body: await webauthnFinishBody(req, kind),
      headers: {
        ...chromeExtensionHeaders(),
        ...cookieHeaders,
      },
    })
    // authentication/finish may rotate sid onto the passkey owner; persist immediately.
    if (kind === 'authentication') {
      await captureSid(baseUrl, res)
    }
    return data
  } finally {
    await clearWebauthnSession()
  }
}

export async function passkeyRegistrationBegin(args?: {
  displayName?: string
}): Promise<BackendWebauthnBeginResponse> {
  const extra: Record<string, unknown> = {}
  if (args?.displayName !== undefined && args.displayName !== '') {
    extra.displayName = args.displayName
  }
  return passkeyBegin('/api/webauthn/registration/begin', 'registration', extra)
}

export async function passkeyRegistrationFinish(
  req: BackendWebauthnRegistrationFinishRequest
): Promise<BackendWebauthnRegistrationFinishResponse> {
  return passkeyFinish<BackendWebauthnRegistrationFinishResponse>(
    '/api/webauthn/registration/finish',
    'registration',
    req
  )
}

export async function passkeyAuthenticationBegin(): Promise<BackendWebauthnBeginResponse> {
  return passkeyBegin('/api/webauthn/authentication/begin', 'authentication')
}

/** Wallet-scoped WebAuthn begin for `/v1/auth/sign-in` (sets extension rpId). */
export async function passkeyAuthenticationBeginForWallet(
  wallet: string,
  keyType: string
): Promise<BackendWebauthnBeginResponse> {
  return passkeyBegin('/api/webauthn/authentication/begin', 'authentication', {
    wallet: wallet.trim(),
    key_type: keyType,
  })
}

export async function passkeyAuthenticationFinish(
  req: BackendWebauthnAuthenticationFinishRequest
): Promise<BackendWebauthnAuthenticationFinishResponse> {
  return passkeyFinish<BackendWebauthnAuthenticationFinishResponse>(
    '/api/webauthn/authentication/finish',
    'authentication',
    req
  )
}
