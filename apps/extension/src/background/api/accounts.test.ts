import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBackendAccounts } from './accounts'

describe('getBackendAccounts', () => {
  beforeEach(() => {
    vi.stubEnv('PLASMO_PUBLIC_LATCH_API_URL', 'https://latch-backend.onrender.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('omits network and keeps credentialId', async () => {
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
      'https://latch-backend.onrender.com/api/accounts?credentialId=cred-a',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('omits the query when there is no credential id', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() {
        return JSON.stringify({ accounts: [] })
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await getBackendAccounts()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://latch-backend.onrender.com/api/accounts',
      expect.objectContaining({ method: 'GET' })
    )
  })
})
