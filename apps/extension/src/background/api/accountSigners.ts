import type {
  AddAccountSignerRequest,
  AddAccountSignerResponse,
  ConfirmAddAccountSignerRequest,
  ConfirmAddAccountSignerResponse,
  ConfirmRemoveAccountSignerRequest,
  ConfirmRemoveAccountSignerResponse,
  RemoveAccountSignerRequest,
  RemoveAccountSignerResponse,
} from '@latch/types'

import { latchFetch } from './client'
import { withActiveNetwork } from './withActiveNetwork'

/**
 * Build an `add_signer` call on the account's Default context rule. Returns a
 * `BuildAuthTransactionResult` in the same shape `setup-swap-rules` returns, so
 * the existing passkey signing path submits it unchanged — or
 * `alreadyConfigured` when this key data already signs for the account.
 */
export async function addAccountSigner(
  req: AddAccountSignerRequest
): Promise<AddAccountSignerResponse> {
  return await latchFetch<AddAccountSignerResponse>('/api/smart-account/add-signer', {
    method: 'POST',
    body: JSON.stringify(await withActiveNetwork(req)),
  })
}

/**
 * Record the new signer after its transaction settled.
 *
 * The API re-fetches `txHash` and decodes it rather than trusting the client,
 * then stores the contract's returned `signer_id` (unrecoverable afterwards —
 * `get_context_rule` returns signers without ids) and writes the recovery-index
 * row that makes fresh-device restore with the backup passkey work.
 */
export async function confirmAddAccountSigner(
  req: ConfirmAddAccountSignerRequest
): Promise<ConfirmAddAccountSignerResponse> {
  return await latchFetch<ConfirmAddAccountSignerResponse>(
    '/api/smart-account/add-signer/confirm',
    {
      method: 'POST',
      body: JSON.stringify(await withActiveNetwork(req)),
    }
  )
}

/** Build a `remove_signer` call. Rejects server-side if it would lock the caller out. */
export async function removeAccountSigner(
  req: RemoveAccountSignerRequest
): Promise<RemoveAccountSignerResponse> {
  return await latchFetch<RemoveAccountSignerResponse>('/api/smart-account/remove-signer', {
    method: 'POST',
    body: JSON.stringify(await withActiveNetwork(req)),
  })
}

/** Drop the signer's index rows once its removal settled on-chain. */
export async function confirmRemoveAccountSigner(
  req: ConfirmRemoveAccountSignerRequest
): Promise<ConfirmRemoveAccountSignerResponse> {
  return await latchFetch<ConfirmRemoveAccountSignerResponse>(
    '/api/smart-account/remove-signer/confirm',
    {
      method: 'POST',
      body: JSON.stringify(await withActiveNetwork(req)),
    }
  )
}
