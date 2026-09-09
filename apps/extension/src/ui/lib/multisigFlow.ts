import type {
  CreateMultisigProposalRequest,
  CreateMultisigProposalResponse,
  BackendWebauthnBeginResponse,
  CreateMultisigDraftResponse,
  MultisigDeployResponse,
  MultisigDraft,
  MultisigDraftMember,
  MultisigDraftMemberRequest,
  MultisigJoinPreviewResponse,
  MultisigPredictResponse,
  MultisigProposalDetail,
  StoredAccount,
} from '@latch/types'

import { friendlyError, sendToBackground } from './backgroundClient'

export async function apiCreateMultisigDraft(): Promise<CreateMultisigDraftResponse> {
  const res = await sendToBackground<undefined, CreateMultisigDraftResponse>({
    type: 'MULTISIG_CREATE_DRAFT',
    payload: undefined,
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiGetActiveDraft(): Promise<
  import('@latch/types').GetActiveMultisigDraftResponse
> {
  const res = await sendToBackground<
    undefined,
    import('@latch/types').GetActiveMultisigDraftResponse
  >({
    type: 'MULTISIG_GET_ACTIVE_DRAFT',
    payload: undefined,
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiJoinPreview(token: string): Promise<MultisigJoinPreviewResponse> {
  const res = await sendToBackground<{ token: string }, MultisigJoinPreviewResponse>({
    type: 'MULTISIG_JOIN_PREVIEW',
    payload: { token },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

/** Paste-a-G-address owner — backend type is `seed`, not `g_address`. */
export function buildSeedDraftMemberFromGAddress(
  label: string,
  gAddress: string
): MultisigDraftMemberRequest {
  return {
    label,
    memberType: 'seed',
    gAddress: gAddress.trim(),
  }
}

export async function apiAddDraftMember(
  draftId: string,
  member: MultisigDraftMemberRequest
): Promise<MultisigDraft> {
  const res = await sendToBackground<
    { draftId: string; member: MultisigDraftMemberRequest },
    MultisigDraft
  >({
    type: 'MULTISIG_ADD_DRAFT_MEMBER',
    payload: { draftId, member },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiRemoveDraftMember(
  draftId: string,
  memberId: string
): Promise<MultisigDraft> {
  const res = await sendToBackground<{ draftId: string; memberId: string }, MultisigDraft>({
    type: 'MULTISIG_REMOVE_DRAFT_MEMBER',
    payload: { draftId, memberId },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiUpdateDraftThreshold(
  draftId: string,
  threshold: number
): Promise<MultisigDraft> {
  const res = await sendToBackground<{ draftId: string; threshold: number }, MultisigDraft>({
    type: 'MULTISIG_UPDATE_DRAFT_THRESHOLD',
    payload: { draftId, threshold },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiPredictDraft(draftId: string): Promise<MultisigPredictResponse> {
  const res = await sendToBackground<{ draftId: string }, MultisigPredictResponse>({
    type: 'MULTISIG_PREDICT_DRAFT',
    payload: { draftId },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiDeployDraft(draftId: string): Promise<MultisigDeployResponse> {
  const res = await sendToBackground<{ draftId: string }, MultisigDeployResponse>({
    type: 'MULTISIG_DEPLOY_DRAFT',
    payload: { draftId },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiDraftPasskeyRegBegin(
  draftId: string,
  displayName?: string
): Promise<BackendWebauthnBeginResponse> {
  const res = await sendToBackground<
    { draftId: string; displayName?: string },
    BackendWebauthnBeginResponse
  >({
    type: 'MULTISIG_DRAFT_PASSKEY_REG_BEGIN',
    payload: { draftId, displayName },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiDraftPasskeyRegFinish(
  draftId: string,
  response: unknown
): Promise<{ credentialId: string; keyDataHex: string }> {
  const res = await sendToBackground<
    { draftId: string; response: unknown },
    { credentialId: string; keyDataHex: string }
  >({
    type: 'MULTISIG_DRAFT_PASSKEY_REG_FINISH',
    payload: { draftId, response },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiDraftPasskeyAuthBegin(
  draftId: string,
  displayName?: string
): Promise<BackendWebauthnBeginResponse> {
  const res = await sendToBackground<
    { draftId: string; displayName?: string },
    BackendWebauthnBeginResponse
  >({
    type: 'MULTISIG_DRAFT_PASSKEY_AUTH_BEGIN',
    payload: { draftId, displayName },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiDraftPasskeyAuthFinish(
  draftId: string,
  response: unknown
): Promise<{ credentialId: string; keyDataHex: string }> {
  const res = await sendToBackground<
    { draftId: string; response: unknown },
    { credentialId: string; keyDataHex: string }
  >({
    type: 'MULTISIG_DRAFT_PASSKEY_AUTH_FINISH',
    payload: { draftId, response },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiJoinPasskeyRegBegin(
  token: string,
  displayName?: string
): Promise<BackendWebauthnBeginResponse> {
  const res = await sendToBackground<
    { token: string; displayName?: string },
    BackendWebauthnBeginResponse
  >({
    type: 'MULTISIG_JOIN_PASSKEY_REG_BEGIN',
    payload: { token, displayName },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiJoinPasskeyRegFinish(
  token: string,
  response: unknown
): Promise<{ credentialId: string; keyDataHex: string }> {
  const res = await sendToBackground<
    { token: string; response: unknown },
    { credentialId: string; keyDataHex: string }
  >({
    type: 'MULTISIG_JOIN_PASSKEY_REG_FINISH',
    payload: { token, response },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiJoinPasskeyAuthBegin(
  token: string,
  displayName?: string
): Promise<BackendWebauthnBeginResponse> {
  const res = await sendToBackground<
    { token: string; displayName?: string },
    BackendWebauthnBeginResponse
  >({
    type: 'MULTISIG_JOIN_PASSKEY_AUTH_BEGIN',
    payload: { token, displayName },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiJoinPasskeyAuthFinish(
  token: string,
  response: unknown
): Promise<{ credentialId: string; keyDataHex: string }> {
  const res = await sendToBackground<
    { token: string; response: unknown },
    { credentialId: string; keyDataHex: string }
  >({
    type: 'MULTISIG_JOIN_PASSKEY_AUTH_FINISH',
    payload: { token, response },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiJoinMember(
  token: string,
  member: MultisigDraftMemberRequest
): Promise<MultisigDraft> {
  const res = await sendToBackground<
    { token: string; member: MultisigDraftMemberRequest },
    MultisigDraft
  >({
    type: 'MULTISIG_JOIN_MEMBER',
    payload: { token, member },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiSyncLocalMultisigAccounts(opts?: {
  activateFirstCreated?: boolean
}): Promise<{
  accounts: StoredAccount[]
  activeAccountId?: string
  created: StoredAccount[]
  updated: boolean
}> {
  const res = await sendToBackground<
    { activateFirstCreated?: boolean },
    {
      accounts: StoredAccount[]
      activeAccountId?: string
      created: StoredAccount[]
      updated: boolean
    }
  >({
    type: 'MULTISIG_SYNC_LOCAL_ACCOUNTS',
    payload: opts ?? {},
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiGetMultisigProposalsBannerDismissed(): Promise<string[]> {
  const res = await sendToBackground<undefined, { accountIds: string[] }>({
    type: 'MULTISIG_GET_PROPOSALS_BANNER_DISMISSED',
    payload: undefined,
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data.accountIds
}

export async function apiDismissMultisigProposalsBanner(accountId: string): Promise<string[]> {
  const res = await sendToBackground<{ accountId: string }, { accountIds: string[] }>({
    type: 'MULTISIG_DISMISS_PROPOSALS_BANNER',
    payload: { accountId },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data.accountIds
}

export async function apiCreateLocalMultisigAccount(args: {
  smartAccountAddress: string
  label?: string
  multisigThreshold?: number
  multisigMemberId?: string
  multisigBackendAccountId?: string
}) {
  const res = await sendToBackground<
    typeof args,
    { account: import('@latch/types').StoredAccount }
  >({
    type: 'MULTISIG_CREATE_LOCAL_ACCOUNT',
    payload: args,
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

/**
 * Attach a multisig wallet the user already co-owns. The background proves
 * membership (backend member row or on-chain signer read) before adding.
 */
export async function apiAddExistingMultisigAccount(args: {
  smartAccountAddress: string
  label?: string
}) {
  const res = await sendToBackground<
    import('@latch/types').AddExistingMultisigAccountRequest,
    import('@latch/types').AddExistingMultisigAccountResponse
  >({
    type: 'MULTISIG_ADD_EXISTING_ACCOUNT',
    payload: args,
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiCreateMultisigProposal(
  req: CreateMultisigProposalRequest
): Promise<CreateMultisigProposalResponse> {
  const res = await sendToBackground<CreateMultisigProposalRequest, CreateMultisigProposalResponse>(
    {
      type: 'MULTISIG_CREATE_PROPOSAL',
      payload: req,
    }
  )
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiListMultisigAccounts() {
  const res = await sendToBackground<
    undefined,
    import('@latch/types').ListMultisigAccountsResponse
  >({
    type: 'MULTISIG_LIST_ACCOUNTS',
    payload: undefined,
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export async function apiGetProposal(proposalId: string): Promise<MultisigProposalDetail> {
  const res = await sendToBackground<{ proposalId: string }, MultisigProposalDetail>({
    type: 'MULTISIG_GET_PROPOSAL',
    payload: { proposalId },
  })
  if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
  return res.data
}

export function extractDraftId(data: CreateMultisigDraftResponse): string {
  const id = data.draft?.id ?? (data as { id?: string }).id
  if (!id) throw new Error('Draft creation did not return an id.')
  return id
}

export function extractInviteToken(data: CreateMultisigDraftResponse): string {
  const token =
    data.inviteToken ??
    data.draft?.inviteToken ??
    (data.draft as { invite_token?: string } | undefined)?.invite_token
  if (!token) throw new Error('Draft creation did not return an invite token.')
  return token
}

export function memberCountFromDraft(
  draft:
    | MultisigDraft
    | { members?: MultisigDraftMember[]; validMemberCount?: number }
    | null
    | undefined
): number {
  if (!draft) return 0
  return draft.validMemberCount ?? draft.members?.length ?? 0
}
