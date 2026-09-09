import type { BackendAccountsResponse } from '@latch/types'

import { latchFetch } from './client'

export async function getBackendAccounts(opts?: {
  credentialId?: string
}): Promise<BackendAccountsResponse> {
  const qs =
    opts?.credentialId && opts.credentialId.trim() !== ''
      ? `?credentialId=${encodeURIComponent(opts.credentialId.trim())}`
      : ''
  return await latchFetch<BackendAccountsResponse>(`/api/accounts${qs}`, { method: 'GET' })
}

export async function setBackendActiveAccount(args: {
  smartAccountAddress: string
}): Promise<{ ok: true }> {
  return await latchFetch<{ ok: true }>('/api/accounts/set-active', {
    method: 'POST',
    body: JSON.stringify(args),
  })
}
