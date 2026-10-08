import type { BackendAccountsResponse, Network } from '@latch/types'

import { getActiveNetwork } from '../network/config'
import { latchFetch } from './client'

export async function getBackendAccounts(opts?: {
  credentialId?: string
  network?: Network
}): Promise<BackendAccountsResponse> {
  const explicit = opts?.network
  const network: Network =
    explicit === 'mainnet' || explicit === 'testnet' ? explicit : await getActiveNetwork()
  const params = new URLSearchParams({ network })
  const credentialId = opts?.credentialId?.trim()
  if (credentialId) params.set('credentialId', credentialId)
  return await latchFetch<BackendAccountsResponse>(`/api/accounts?${params.toString()}`, {
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
