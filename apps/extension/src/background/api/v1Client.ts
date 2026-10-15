import type { V1TokenPair } from '@latch/types'

import { latchApiBaseUrl, latchRequestTimeoutMs, noteLatchApiSuccess } from './config'
import { BackendError } from './client'
import { clearV1TokenPair, getV1TokenPair, isTokenFresh, setV1TokenPair } from './v1TokenStorage'
import { buildWalletSignInBodyFromAssertion } from './v1WalletSignIn'
import { withActiveNetwork } from './withActiveNetwork'

export { base64UrlToStandardB64, buildWalletSignInBodyFromAssertion } from './v1WalletSignIn'

type V1Envelope<T> = { data?: T; error?: { code?: string; message?: string } }

function unwrapV1<T>(data: unknown, _path: string): T {
  if (data && typeof data === 'object' && 'data' in data) {
    return (data as V1Envelope<T>).data as T
  }
  return data as T
}

export async function v1FetchAbsolute<T>(
  url: string,
  init?: RequestInit & { accessToken?: string; timeoutMs?: number }
): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = await latchRequestTimeoutMs(init?.timeoutMs, 20_000)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    }
    if (init?.accessToken) {
      headers.authorization = `Bearer ${init.accessToken}`
    }

    const res = await fetch(url, {
      ...init,
      credentials: 'omit',
      signal: controller.signal,
      headers,
    })

    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      throw new BackendError(`v1 API invalid JSON (${res.status}) for ${url}`, {
        status: res.status,
      })
    }

    if (!res.ok) {
      const err = (json as V1Envelope<unknown>)?.error
      throw new BackendError(err?.message ?? `v1 request failed (${res.status})`, {
        status: res.status,
        code: err?.code,
        details: json,
      })
    }

    const data = unwrapV1<T>(json, url)
    await noteLatchApiSuccess()
    return data
  } catch (err) {
    if (err instanceof BackendError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new BackendError('Request timed out', { code: 'timeout' })
    }
    throw new BackendError(err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timeout)
  }
}

export async function v1Fetch<T>(
  path: string,
  init?: RequestInit & { accessToken?: string; timeoutMs?: number }
): Promise<T> {
  const baseUrl = await latchApiBaseUrl()
  return v1FetchAbsolute<T>(`${baseUrl}${path}`, init)
}

async function refreshV1TokensForWallet(wallet: string, refreshToken: string): Promise<string> {
  const refreshed = await refreshV1Tokens(refreshToken)
  const next: V1TokenPair = {
    ...refreshed,
    wallet,
  }
  await setV1TokenPair(wallet, next)
  return next.accessToken
}

async function retryV1FetchAfter401<T>(
  wallet: string,
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const pair = await getV1TokenPair(wallet)
  if (!pair?.refreshToken) {
    await clearV1TokenPair(wallet)
    throw new BackendError('V1 auth required', { code: 'V1_AUTH_REQUIRED', status: 401 })
  }

  try {
    const accessToken = await refreshV1TokensForWallet(wallet, pair.refreshToken)
    return await v1Fetch<T>(path, { ...init, accessToken })
  } catch (err) {
    await clearV1TokenPair(wallet)
    if (err instanceof BackendError && err.status === 401) {
      throw new BackendError('V1 auth required', { code: 'V1_AUTH_REQUIRED', status: 401 })
    }
    throw err
  }
}

export async function v1FetchForWallet<T>(
  wallet: string,
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const normalizedWallet = wallet.trim()
  const accessToken = await resolveAccessToken(normalizedWallet)

  try {
    return await v1Fetch<T>(path, { ...init, accessToken })
  } catch (err) {
    if (err instanceof BackendError && err.status === 401) {
      return retryV1FetchAfter401<T>(normalizedWallet, path, init)
    }
    throw err
  }
}

export async function resolveAccessToken(wallet: string): Promise<string> {
  const pair = await getV1TokenPair(wallet)
  if (!pair) {
    throw new BackendError('V1 auth required', { code: 'V1_AUTH_REQUIRED' })
  }
  if (isTokenFresh(pair)) return pair.accessToken
  return refreshV1TokensForWallet(wallet.trim(), pair.refreshToken)
}

export async function refreshV1Tokens(refreshToken: string): Promise<V1TokenPair> {
  const data = await v1Fetch<{ access_token: string; refresh_token: string; expires_in: number }>(
    '/v1/auth/refresh',
    {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    }
  )
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
    wallet: '',
  }
}

export async function requestWalletChallenge(
  wallet: string,
  keyType: string
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { wallet, key_type: keyType }
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    body.chromeExtensionId = chrome.runtime.id
  }
  const withNetwork = await withActiveNetwork(body)
  return v1Fetch<Record<string, unknown>>('/v1/auth/challenge', {
    method: 'POST',
    body: JSON.stringify(withNetwork),
  })
}

export async function completeWalletSignIn(body: Record<string, unknown>): Promise<V1TokenPair> {
  // Always send chromeExtensionId for extension clients so the API can expand the
  // V1 wallet-auth origin allowlist to chrome-extension://<id> (see wallet auth wiring).
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    body.chromeExtensionId = chrome.runtime.id
  }
  const withNetwork = await withActiveNetwork(body)
  const data = await v1Fetch<{
    access_token: string
    refresh_token: string
    expires_in: number
  }>('/v1/auth/sign-in', {
    method: 'POST',
    body: JSON.stringify(withNetwork),
  })
  const wallet = String(withNetwork.wallet ?? '').trim()
  const pair: V1TokenPair = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
    wallet,
  }
  if (wallet) await setV1TokenPair(wallet, pair)
  return pair
}

export async function completeWalletSignInFromAssertion(args: {
  wallet: string
  keyType: string
  nonce: string
  assertion: unknown
  keyDataHex?: string
}): Promise<V1TokenPair> {
  const body = buildWalletSignInBodyFromAssertion(args)
  return completeWalletSignIn(body)
}
