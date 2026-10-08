import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearCachedActiveNetwork, setCachedActiveNetwork } from '../network/config'
import { getBackendAccounts } from './accounts'

describe('getBackendAccounts', () => {
  beforeEach(() => {
    clearCachedActiveNetwork()
    vi.stubEnv('PLASMO_PUBLIC_LATCH_API_URL', 'https://latch-backend.onrender.com')
  })

  afterEach(() => {
    clearCachedActiveNetwork()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('requests the active network and keeps credentialId', async () => {
    setCachedActiveNetwork('mainnet')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() {
        return JSON.stringify({ accounts: [] })
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await getBackendAccounts({ credentialId: 'cred-a' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://latch-backend.onrender.com/api/accounts?network=mainnet&credentialId=cred-a',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('keeps an explicit network over the active one', async () => {
    setCachedActiveNetwork('mainnet')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() {
        return JSON.stringify({ accounts: [] })
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await getBackendAccounts({ network: 'testnet' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://latch-backend.onrender.com/api/accounts?network=testnet',
      expect.objectContaining({ method: 'GET' })
    )
  })
})
