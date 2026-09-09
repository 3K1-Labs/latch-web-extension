/**
 * Multisig API types — aligned with Latch backend Swagger (doc.json).
 */

/** Backend draft/register member types (see POST /api/multisig/drafts/{id}/members). */
export type MultisigMemberType = 'passkey' | 'seed' | 'delegated'

export interface MultisigSignerInitRequest {
  type: string
  label?: string
  gAddress?: string
  keyDataHex?: string
}

export interface MultisigDraftMemberRequest {
  label: string
  memberType: string
  credentialId?: string
  keyDataHex?: string
  gAddress?: string
  publicKeyHex?: string
}

export interface MultisigDraftMember {
  id: string
  label?: string
  memberType?: string
  gAddress?: string
  credentialId?: string
  keyDataHex?: string
  publicKeyHex?: string
  [key: string]: unknown
}

export interface MultisigDraft {
  id: string
  status?: string
  threshold?: number
  inviteToken?: string
  members?: MultisigDraftMember[]
  smartAccountAddress?: string
  validMemberCount?: number
  canDeploy?: boolean
  [key: string]: unknown
}

export interface CreateMultisigDraftResponse {
  draft: MultisigDraft
  inviteToken?: string
  [key: string]: unknown
}

export interface GetActiveMultisigDraftResponse {
  draft: MultisigDraft | null
  [key: string]: unknown
}

export interface UpdateMultisigDraftThresholdRequest {
  draftId: string
  threshold: number
}

export interface MultisigDraftMemberActionRequest {
  draftId: string
  member: MultisigDraftMemberRequest
}

export interface MultisigDraftMemberRemoveRequest {
  draftId: string
  memberId: string
}

export interface MultisigDraftIdRequest {
  draftId: string
}

export interface MultisigPredictResponse {
  smartAccountAddress?: string
  accountSaltHex?: string
  alreadyDeployed?: boolean
  [key: string]: unknown
}

export interface MultisigDeployResponse {
  smartAccountAddress: string
  alreadyDeployed?: boolean
  transactionHash?: string
  hash?: string
  [key: string]: unknown
}

export interface MultisigAccountMember {
  id: string
  label?: string
  type?: string
  memberType?: string
  gAddress?: string
  credentialId?: string
  [key: string]: unknown
}

export interface MultisigAccount {
  id?: string
  smartAccountAddress: string
  threshold?: number
  members?: MultisigAccountMember[]
  memberId?: string
  label?: string
  [key: string]: unknown
}

export interface ListMultisigAccountsResponse {
  accounts?: MultisigAccount[]
  [key: string]: unknown
}

export interface RegisterMultisigAccountRequest {
  smartAccountAddress: string
  threshold: number
  accountSaltHex: string
  members: Array<{
    type: string
    label?: string
    gAddress?: string
    credentialId?: string
    keyDataHex?: string
  }>
}

export interface AddExistingMultisigAccountRequest {
  /** Deployed multisig smart account address (C…). */
  smartAccountAddress: string
  label?: string
}

export interface AddExistingMultisigAccountResponse {
  account: import('./index').StoredAccount
  activeAccountId?: string
  /** How membership was proven: backend member row, or on-chain signer read. */
  verifiedVia: 'backend' | 'onchain'
}

export interface MultisigJoinPreviewResponse {
  draft?: MultisigDraft
  threshold?: number
  members?: MultisigDraftMember[]
  validMemberCount?: number
  [key: string]: unknown
}

export interface MultisigJoinMemberRequest {
  token: string
  member: MultisigDraftMemberRequest
}

export interface MultisigJoinTokenRequest {
  token: string
}

export interface MultisigDraftPasskeyRegBeginRequest {
  draftId: string
  displayName?: string
}

export interface MultisigDraftPasskeyRegFinishRequest {
  draftId: string
  response: unknown
}

export interface MultisigDraftPasskeyRegFinishResponse {
  credentialId: string
  keyDataHex: string
  [key: string]: unknown
}

export interface MultisigJoinPasskeyRegBeginRequest {
  token: string
  displayName?: string
}

export interface MultisigJoinPasskeyRegFinishRequest {
  token: string
  response: unknown
}

export type MultisigProposalStatus = 'pending' | 'approved' | 'executed' | 'failed' | string

export interface MultisigProposalApproval {
  memberId?: string
  label?: string
  signedAt?: string
  [key: string]: unknown
}

export interface MultisigProposal {
  id: string
  status?: MultisigProposalStatus
  smartAccountAddress?: string
  operationKind?: string
  recipient?: string
  amount?: string
  assetId?: string
  approvalCount?: number
  threshold?: number
  createdAt?: string
  [key: string]: unknown
}

export interface MultisigProposalDetail extends MultisigProposal {
  authDigestHex?: string
  authEntryXdr?: string
  txXdr?: string
  validUntilLedger?: number
  members?: MultisigAccountMember[]
  approvals?: MultisigProposalApproval[]
  memberId?: string
  [key: string]: unknown
}

export interface ListMultisigProposalsRequest {
  smartAccountAddress: string
}

export type MultisigProposalOperationKind = 'sac_transfer' | 'counter_increment'

export interface ListMultisigProposalsResponse {
  proposals?: MultisigProposal[]
  [key: string]: unknown
}

export interface CreateMultisigProposalRequest {
  smartAccountAddress: string
  operationKind: MultisigProposalOperationKind
  recipient?: string
  amount?: string
  assetId?: string
  targetContractId?: string
  tokenContractId?: string
  requireMatchedContextRule?: boolean
}

export interface CreateMultisigProposalResponse {
  id: string
  status?: MultisigProposalStatus
  [key: string]: unknown
}

export interface MultisigProposalIdRequest {
  proposalId: string
}

export interface MultisigApproveWebauthnRequest {
  proposalId: string
  memberId: string
  sigDataXdrHex: string
}

export interface MultisigApproveDelegatedBeginRequest {
  proposalId: string
  memberId: string
}

export interface MultisigApproveDelegatedFinishRequest {
  proposalId: string
  memberId: string
  signedAuthEntryBase64: string
  signerAddress: string
}

export interface MultisigExecuteProposalResponse {
  transactionHash?: string
  hash?: string
  status?: string
  [key: string]: unknown
}

/** Local-only pending invite (chrome.storage.local). */
export interface MultisigPendingInvite {
  token: string
  walletName?: string
  draftId?: string
  joinedAt: number
  /** Draft member row id for this user after joining. */
  multisigMemberId?: string
  /** Passkey used when joining — helps sync after deploy. */
  passkeyCredentialId?: string
  /** Cached from join preview — used after deploy when preview 404s. */
  threshold?: number
  smartAccountAddress?: string
  accountSaltHex?: string
  membersSnapshot?: MultisigDraftMember[]
}

/** Local-only in-progress creator draft metadata. */
export interface MultisigDraftMeta {
  draftId: string
  inviteToken: string
  walletName: string
  purpose?: string
}

export interface CreateMultisigAccountParams {
  smartAccountAddress: string
  label?: string
  multisigThreshold?: number
  multisigMemberId?: string
  multisigBackendAccountId?: string
}
