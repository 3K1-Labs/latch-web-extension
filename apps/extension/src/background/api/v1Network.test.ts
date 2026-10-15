import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getActiveNetwork = vi.fn(async () => 'mainnet' as const)

vi.mock('../network/config', () => ({
  getActiveNetwork: () => getActiveNetwork(),
  clearCachedActiveNetwork: () => undefined,
}))

import { createDepositIntent } from './deposit'
import { completeWalletSignIn, requestWalletChallenge } from './v1Client'

describe('V1 Fund path network propagation', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    getActiveNetwork.mockResolvedValue('mainnet')
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext-id-abc' },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    })
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends active network on challenge', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: { nonce: 'abc', expires_in: 60, network: 'mainnet' },
        })
      },
    })

    await requestWalletChallenge('CABC', 'passkey')

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body).toMatchObject({
      wallet: 'CABC',
      key_type: 'passkey',
      chromeExtensionId: 'ext-id-abc',
    })
    expect(body.network).toBeUndefined()
  })

  it('sends active network on sign-in', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: {
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 900,
          },
        })
      },
    })

    await completeWalletSignIn({
      wallet: 'CABC',
      key_type: 'passkey',
      nonce: 'n',
      client_data_json: 'Yw==',
      authenticator_data: 'YQ==',
      passkey_signature: 'Yg==',
    })

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.network).toBeUndefined()
    expect(body.chromeExtensionId).toBe('ext-id-abc')
  })

  it('strips an explicit network on sign-in', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: { access_token: 'a', refresh_token: 'r', expires_in: 900 },
        })
      },
    })

    await completeWalletSignIn({
      wallet: 'CABC',
      key_type: 'passkey',
      nonce: 'n',
      network: 'testnet',
      client_data_json: 'Yw==',
      authenticator_data: 'YQ==',
      passkey_signature: 'Yg==',
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(body.network).toBeUndefined()
  })

  it('sends active network on deposit-intent', async () => {
    const store: Record<string, unknown> = {
      'latch.v1TokensByWallet': {
        'mainnet:CABC': {
          accessToken: 'tok',
          refreshToken: 'ref',
          expiresAt: Date.now() + 60_000,
          wallet: 'CABC',
        },
      },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext-id-abc' },
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

    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      async text() {
        return JSON.stringify({
          data: {
            intent_id: 'i1',
            memo_id: '123',
            pool_address: 'GPOOL',
            expires_at: '2026-07-21T12:00:00Z',
          },
        })
      },
    })

    await createDepositIntent('CABC', 'CABC')

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(body).toEqual({
      smart_account_address: 'CABC',
    })
  })

  it('sends provider and crypto_currency on deposit-intent for Transak', async () => {
    const store: Record<string, unknown> = {
      'latch.v1TokensByWallet': {
        'mainnet:CABC': {
          accessToken: 'tok',
          refreshToken: 'ref',
          expiresAt: Date.now() + 60_000,
          wallet: 'CABC',
        },
      },
    }
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext-id-abc' },
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

    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      async text() {
        return JSON.stringify({
          data: {
            intent_id: 'i1',
            memo_id: '123',
            pool_address: 'GPOOL',
            expires_at: '2026-07-21T12:00:00Z',
            widget_url: 'https://global-stg.transak.com?sessionId=x',
          },
        })
      },
    })

    await createDepositIntent('CABC', 'CABC', {
      provider: 'transak',
      cryptoCurrency: 'XLM',
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(body).toEqual({
      smart_account_address: 'CABC',
      provider: 'transak',
      crypto_currency: 'XLM',
    })
  })
})
