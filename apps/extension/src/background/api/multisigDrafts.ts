import type {
  BackendWebauthnBeginResponse,
  CreateMultisigDraftResponse,
  GetActiveMultisigDraftResponse,
  MultisigDeployResponse,
  MultisigDraft,
  MultisigDraftMemberRequest,
  MultisigDraftPasskeyRegFinishResponse,
  MultisigPredictResponse,
  Network,
} from '@latch/types'

import { getActiveNetwork } from '../network/config'
import { latchFetch } from './client'
import { unwrapMultisigDraft } from './multisigNormalize'
import { webauthnBeginBody, webauthnFinishBody } from './webauthn'
import { withActiveNetwork } from './withActiveNetwork'

/** A draft with no network field was stored before the column existed, on testnet. */
function draftNetwork(draft: MultisigDraft): Network {
  return draft.network === 'mainnet' ? 'mainnet' : 'testnet'
}

export async function createMultisigDraft(): Promise<CreateMultisigDraftResponse> {
  return await latchFetch<CreateMultisigDraftResponse>('/api/multisig/drafts', {
    method: 'POST',
    body: JSON.stringify(await withActiveNetwork({})),
  })
}

export async function getActiveMultisigDraft(): Promise<GetActiveMultisigDraftResponse> {
  const res = await latchFetch<GetActiveMultisigDraftResponse>('/api/multisig/drafts?active=1', {
    method: 'GET',
  })
  if (res.draft && draftNetwork(res.draft) !== (await getActiveNetwork())) {
    return { ...res, draft: null }
  }
  return res
}

export async function getMultisigDraft(draftId: string): Promise<MultisigDraft> {
  const raw = await latchFetch<MultisigDraft>(
    `/api/multisig/drafts/${encodeURIComponent(draftId)}`,
    { method: 'GET' }
  )
  return unwrapMultisigDraft(raw) ?? raw
}

export async function updateMultisigDraftThreshold(args: {
  draftId: string
  threshold: number
}): Promise<MultisigDraft> {
  const raw = await latchFetch<MultisigDraft>(
    `/api/multisig/drafts/${encodeURIComponent(args.draftId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ threshold: args.threshold }),
    }
  )
  return unwrapMultisigDraft(raw) ?? raw
}

export async function addMultisigDraftMember(args: {
  draftId: string
  member: MultisigDraftMemberRequest
}): Promise<MultisigDraft> {
  const raw = await latchFetch<MultisigDraft>(
    `/api/multisig/drafts/${encodeURIComponent(args.draftId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify(args.member),
    }
  )
  return unwrapMultisigDraft(raw) ?? raw
}

export async function removeMultisigDraftMember(args: {
  draftId: string
  memberId: string
}): Promise<MultisigDraft> {
  const raw = await latchFetch<MultisigDraft>(
    `/api/multisig/drafts/${encodeURIComponent(args.draftId)}/members/${encodeURIComponent(args.memberId)}`,
    { method: 'DELETE' }
  )
  return unwrapMultisigDraft(raw) ?? raw
}

export async function predictMultisigDraftAddress(
  draftId: string
): Promise<MultisigPredictResponse> {
  return await latchFetch<MultisigPredictResponse>(
    `/api/multisig/drafts/${encodeURIComponent(draftId)}/predict`,
    { method: 'POST' }
  )
}

export async function deployMultisigDraft(draftId: string): Promise<MultisigDeployResponse> {
  return await latchFetch<MultisigDeployResponse>(
    `/api/multisig/drafts/${encodeURIComponent(draftId)}/deploy`,
    { method: 'POST' }
  )
}

export async function multisigDraftPasskeyRegBegin(args: {
  draftId: string
  displayName?: string
}): Promise<BackendWebauthnBeginResponse> {
  const extra: Record<string, unknown> = {}
  if (args.displayName) extra.displayName = args.displayName
  return await latchFetch<BackendWebauthnBeginResponse>(
    `/api/multisig/drafts/${encodeURIComponent(args.draftId)}/webauthn/register/begin`,
    { method: 'POST', body: webauthnBeginBody(extra) }
  )
}

export async function multisigDraftPasskeyRegFinish(args: {
  draftId: string
  response: unknown
}): Promise<MultisigDraftPasskeyRegFinishResponse> {
  return await latchFetch<MultisigDraftPasskeyRegFinishResponse>(
    `/api/multisig/drafts/${encodeURIComponent(args.draftId)}/webauthn/register/finish`,
    {
      method: 'POST',
      body: await webauthnFinishBody({ response: args.response }, 'registration'),
    }
  )
}

export async function multisigDraftPasskeyAuthBegin(args: {
  draftId: string
  displayName?: string
}): Promise<BackendWebauthnBeginResponse> {
  const extra: Record<string, unknown> = {}
  if (args.displayName) extra.displayName = args.displayName
  return await latchFetch<BackendWebauthnBeginResponse>(
    `/api/multisig/drafts/${encodeURIComponent(args.draftId)}/webauthn/authenticate/begin`,
    { method: 'POST', body: webauthnBeginBody(extra) }
  )
}

export async function multisigDraftPasskeyAuthFinish(args: {
  draftId: string
  response: unknown
}): Promise<MultisigDraftPasskeyRegFinishResponse> {
  return await latchFetch<MultisigDraftPasskeyRegFinishResponse>(
    `/api/multisig/drafts/${encodeURIComponent(args.draftId)}/webauthn/authenticate/finish`,
    {
      method: 'POST',
      body: await webauthnFinishBody({ response: args.response }, 'authentication'),
    }
  )
}
