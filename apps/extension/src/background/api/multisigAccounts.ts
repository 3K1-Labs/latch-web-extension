import type {
  ListMultisigAccountsResponse,
  MultisigDeployResponse,
  MultisigPredictResponse,
  MultisigSignerInitRequest,
  RegisterMultisigAccountRequest,
} from '@latch/types'

import { normalizeMultisigSignersForApi } from '../../lib/multisigSignerInit'
import { latchFetch } from './client'
import { withActiveNetwork } from './withActiveNetwork'

export async function listMultisigAccounts(): Promise<ListMultisigAccountsResponse> {
  return await latchFetch<ListMultisigAccountsResponse>('/api/multisig/accounts', { method: 'GET' })
}

export async function predictMultisigAccountFromSigners(args: {
  threshold: number
  signers: MultisigSignerInitRequest[]
  accountSaltHex?: string
}): Promise<MultisigPredictResponse> {
  return await latchFetch<MultisigPredictResponse>('/api/multisig/accounts/draft', {
    method: 'POST',
    body: JSON.stringify(
      await withActiveNetwork({
        threshold: args.threshold,
        accountSaltHex: args.accountSaltHex,
        signers: normalizeMultisigSignersForApi(args.signers),
      })
    ),
  })
}

export async function deployMultisigAccount(args: {
  threshold: number
  signers: MultisigSignerInitRequest[]
  accountSaltHex: string
}): Promise<MultisigDeployResponse> {
  return await latchFetch<MultisigDeployResponse>('/api/multisig/accounts/deploy', {
    method: 'POST',
    body: JSON.stringify(
      await withActiveNetwork({
        threshold: args.threshold,
        accountSaltHex: args.accountSaltHex,
        signers: normalizeMultisigSignersForApi(args.signers),
      })
    ),
  })
}

export async function registerMultisigAccount(
  req: RegisterMultisigAccountRequest
): Promise<Record<string, unknown>> {
  return await latchFetch<Record<string, unknown>>('/api/multisig/accounts/register', {
    method: 'POST',
    body: JSON.stringify(await withActiveNetwork(req)),
  })
}
