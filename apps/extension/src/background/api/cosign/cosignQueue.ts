import type {
  CosignRequest,
  CreateCosignRequestInput,
  PostJoinRelayRequest,
  JoinRelayRecord,
} from '@latch/types'

import { v1FetchForWallet } from '../v1Client'

export async function createCosignRequest(
  wallet: string,
  input: CreateCosignRequestInput
): Promise<CosignRequest> {
  return v1FetchForWallet(wallet, '/v1/cosign/requests', {
    method: 'POST',
    body: JSON.stringify({
      queue_index: input.queueIndex,
      unsigned_tx_xdr: input.unsignedTxXdr,
      threshold: input.threshold,
    }),
  })
}

export async function listPendingCosignRequests(
  wallet: string,
  queueIndex: string
): Promise<CosignRequest[]> {
  const data = await v1FetchForWallet<{ requests: CosignRequest[] }>(
    wallet,
    `/v1/cosign/requests?queue_index=${encodeURIComponent(queueIndex)}`,
    { method: 'GET' }
  )
  return data.requests ?? []
}

export async function getCosignRequest(wallet: string, id: string): Promise<CosignRequest> {
  return v1FetchForWallet(wallet, `/v1/cosign/requests/${encodeURIComponent(id)}`, {
    method: 'GET',
  })
}

export async function addCosignSignature(
  wallet: string,
  id: string,
  blindSignerId: string,
  authEntryXdr: string
): Promise<CosignRequest> {
  return v1FetchForWallet(wallet, `/v1/cosign/requests/${encodeURIComponent(id)}/signatures`, {
    method: 'POST',
    body: JSON.stringify({ blind_signer_id: blindSignerId, auth_entry_xdr: authEntryXdr }),
  })
}

export async function markCosignSubmitted(
  wallet: string,
  id: string,
  txHash: string
): Promise<{ message: string }> {
  return v1FetchForWallet(wallet, `/v1/cosign/requests/${encodeURIComponent(id)}/submission`, {
    method: 'POST',
    body: JSON.stringify({ tx_hash: txHash }),
  })
}

export async function cancelCosignRequest(
  wallet: string,
  id: string
): Promise<{ message: string }> {
  return v1FetchForWallet(wallet, `/v1/cosign/requests/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function hasReachedThreshold(request: CosignRequest): boolean {
  return request.signature_count >= request.threshold
}

export async function postJoinRelay(
  wallet: string,
  req: PostJoinRelayRequest
): Promise<{ message: string }> {
  return v1FetchForWallet(wallet, '/v1/join-relays', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export async function getJoinRelay(
  wallet: string,
  inviteToken: string
): Promise<JoinRelayRecord | null> {
  try {
    return await v1FetchForWallet<JoinRelayRecord>(
      wallet,
      `/v1/join-relays/${encodeURIComponent(inviteToken)}`,
      { method: 'GET' }
    )
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'status' in err &&
      (err as { status?: number }).status === 404
    ) {
      return null
    }
    throw err
  }
}

export async function deleteJoinRelay(
  wallet: string,
  inviteToken: string
): Promise<{ message: string }> {
  return v1FetchForWallet(wallet, `/v1/join-relays/${encodeURIComponent(inviteToken)}`, {
    method: 'DELETE',
  })
}
