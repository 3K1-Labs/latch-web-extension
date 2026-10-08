import type {
  CreateMultisigProposalRequest,
  CreateMultisigProposalResponse,
  MultisigApproveDelegatedFinishRequest,
  MultisigExecuteProposalResponse,
  MultisigProposalDetail,
  ListMultisigProposalsResponse,
} from '@latch/types'

import { getActiveNetwork } from '../network/config'
import { latchFetch } from './client'
import { latchExtensionJsonBody } from './webauthn'
import { normalizeMultisigProposalDetail } from './multisigNormalize'
import { withActiveNetwork } from './withActiveNetwork'

export async function listMultisigProposals(
  smartAccountAddress: string
): Promise<ListMultisigProposalsResponse> {
  const params = new URLSearchParams({
    account: smartAccountAddress,
    network: await getActiveNetwork(),
  })
  return await latchFetch<ListMultisigProposalsResponse>(
    `/api/multisig/proposals?${params.toString()}`,
    { method: 'GET' }
  )
}

export async function createMultisigProposal(
  req: CreateMultisigProposalRequest
): Promise<CreateMultisigProposalResponse> {
  return await latchFetch<CreateMultisigProposalResponse>('/api/multisig/proposals', {
    method: 'POST',
    body: JSON.stringify(await withActiveNetwork(req)),
  })
}

export async function getMultisigProposal(proposalId: string): Promise<MultisigProposalDetail> {
  const params = new URLSearchParams({ network: await getActiveNetwork() })
  const raw = await latchFetch<unknown>(
    `/api/multisig/proposals/${encodeURIComponent(proposalId)}?${params.toString()}`,
    { method: 'GET' }
  )
  return normalizeMultisigProposalDetail(raw)
}

export async function multisigProposalApproveDelegatedBegin(args: {
  proposalId: string
  memberId: string
}): Promise<Record<string, unknown>> {
  return await latchFetch<Record<string, unknown>>(
    `/api/multisig/proposals/${encodeURIComponent(args.proposalId)}/approve/delegated/begin`,
    {
      method: 'POST',
      body: JSON.stringify(await withActiveNetwork({ memberId: args.memberId })),
    }
  )
}

export async function multisigProposalApproveDelegatedFinish(
  req: MultisigApproveDelegatedFinishRequest
): Promise<MultisigProposalDetail> {
  const raw = await latchFetch<unknown>(
    `/api/multisig/proposals/${encodeURIComponent(req.proposalId)}/approve/delegated/finish`,
    {
      method: 'POST',
      body: JSON.stringify(
        await withActiveNetwork({
          memberId: req.memberId,
          signedAuthEntryBase64: req.signedAuthEntryBase64,
          signerAddress: req.signerAddress,
        })
      ),
    }
  )
  return normalizeMultisigProposalDetail(raw)
}

export async function multisigProposalApproveWebauthn(args: {
  proposalId: string
  memberId: string
  sigDataXdrHex: string
}): Promise<MultisigProposalDetail> {
  const raw = await latchFetch<unknown>(
    `/api/multisig/proposals/${encodeURIComponent(args.proposalId)}/approve/webauthn`,
    {
      method: 'POST',
      body: latchExtensionJsonBody(
        await withActiveNetwork({
          memberId: args.memberId,
          sigDataXdrHex: args.sigDataXdrHex,
        })
      ),
    }
  )
  return normalizeMultisigProposalDetail(raw)
}

export async function executeMultisigProposal(
  proposalId: string
): Promise<MultisigExecuteProposalResponse> {
  return await latchFetch<MultisigExecuteProposalResponse>(
    `/api/multisig/proposals/${encodeURIComponent(proposalId)}/execute`,
    { method: 'POST', body: JSON.stringify(await withActiveNetwork({})) }
  )
}

export async function refreshMultisigProposal(proposalId: string): Promise<MultisigProposalDetail> {
  const raw = await latchFetch<unknown>(
    `/api/multisig/proposals/${encodeURIComponent(proposalId)}/refresh`,
    { method: 'POST', body: JSON.stringify(await withActiveNetwork({})) }
  )
  return normalizeMultisigProposalDetail(raw)
}
