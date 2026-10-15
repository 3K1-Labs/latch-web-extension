import type { BackendAccountsResponse } from '@latch/types'

import { latchFetch } from './client'

export async function getBackendAccounts(opts?: {
  credentialId?: string
}): Promise<BackendAccountsResponse> {
  const params = new URLSearchParams()
  const credentialId = opts?.credentialId?.trim()
  if (credentialId) params.set('credentialId', credentialId)
  const query = params.toString()
  const path = query ? `/api/accounts?${query}` : '/api/accounts'
  return await latchFetch<BackendAccountsResponse>(path, {
    method: 'GET',
  })
}

export async function setBackendActiveAccount(args: {
  smartAccountAddress: string
}): Promise<{ ok: true }> {
  return await latchFetch<{ ok: true }>('/api/accounts/set-active', {
    method: 'POST',
    body: JSON.stringify(args),
  })
}
