import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackendError } from './client'
import { v1FetchForWallet } from './v1Client'
import { clearCachedActiveNetwork } from '../network/config'
import { resetV1TokenLegacyPruneFlag, v1TokenStorageKey } from './v1TokenStorage'

const STORAGE_KEY = 'latch.v1TokensByWallet'

function stubChromeStore(store: Record<string, unknown>) {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const k of list) out[k] = store[k]
          return out
        }),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(store, patch)
        }),
      },
    },
  })
}

describe('v1FetchForWallet', () => {
  afterEach(() => {
    clearCachedActiveNetwork()
    resetV1TokenLegacyPruneFlag()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retries once on 401 after refreshing the wallet token pair', async () => {
    const store: Record<string, unknown> = {
      [STORAGE_KEY]: {
        [v1TokenStorageKey('mainnet', 'CABC123')]: {
          accessToken: 'stale-access',
          refreshToken: 'refresh-raw',
          expiresAt: Date.now() + 60_000,
          wallet: 'CABC123',
        },
      },
    }
    stubChromeStore(store)

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization
      if (url.endsWith('/v1/auth/refresh')) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              data: {
                access_token: 'fresh-access',
                refresh_token: 'fresh-refresh',
                expires_in: 900,
              },
            })
          },
        }
      }
      if (url.endsWith('/v1/accounts/deposit-intent')) {
        if (auth === 'Bearer stale-access') {
          return {
            ok: false,
            status: 401,
            async text() {
              return JSON.stringify({ error: { message: 'token expired', code: 'UNAUTHORIZED' } })
            },
          }
        }
        return {
          ok: true,
          status: 201,
          async text() {
            return JSON.stringify({
              data: {
                intent_id: 'intent-1',
                memo_id: '12345',
                pool_address: 'GPOOL',
                expires_at: '2026-07-21T12:00:00Z',
              },
            })
          },
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await v1FetchForWallet('CABC123', '/v1/accounts/deposit-intent', {
      method: 'POST',
      body: JSON.stringify({ smart_account_address: 'CABC123' }),
    })

    expect(result).toMatchObject({ memo_id: '12345', pool_address: 'GPOOL' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('clears stored tokens and throws V1_AUTH_REQUIRED when refresh fails', async () => {
    const store: Record<string, unknown> = {
      [STORAGE_KEY]: {
        [v1TokenStorageKey('mainnet', 'CABC123')]: {
          accessToken: 'stale-access',
          refreshToken: 'bad-refresh',
          expiresAt: Date.now() + 60_000,
          wallet: 'CABC123',
        },
      },
    }
    stubChromeStore(store)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/v1/auth/refresh')) {
          return {
            ok: false,
            status: 401,
            async text() {
              return JSON.stringify({ error: { message: 'invalid refresh token' } })
            },
          }
        }
        return {
          ok: false,
          status: 401,
          async text() {
            return JSON.stringify({ error: { message: 'token expired' } })
          },
        }
      })
    )

    await expect(
      v1FetchForWallet('CABC123', '/v1/accounts/deposit-intent', { method: 'POST' })
    ).rejects.toMatchObject({
      code: 'V1_AUTH_REQUIRED',
      status: 401,
    } satisfies Partial<BackendError>)

    expect(
      (store[STORAGE_KEY] as Record<string, unknown>)[v1TokenStorageKey('mainnet', 'CABC123')]
    ).toBeUndefined()
  })
})
