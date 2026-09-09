import type { BackgroundMessage } from '@latch/types'

import {
  addMultisigDraftMember,
  createMultisigDraft,
  createMultisigProposal,
  deployMultisigDraft,
  executeMultisigProposal,
  getActiveMultisigDraft,
  getMultisigDraftByInviteToken,
  getMultisigProposal,
  joinMultisigDraft,
  listMultisigAccounts,
  listMultisigProposals,
  multisigDraftPasskeyRegBegin,
  multisigDraftPasskeyRegFinish,
  multisigDraftPasskeyAuthBegin,
  multisigDraftPasskeyAuthFinish,
  multisigJoinPasskeyRegBegin,
  multisigJoinPasskeyRegFinish,
  multisigJoinPasskeyAuthBegin,
  multisigJoinPasskeyAuthFinish,
  multisigProposalApproveDelegatedBegin,
  multisigProposalApproveDelegatedFinish,
  multisigProposalApproveWebauthn,
  predictMultisigDraftAddress,
  refreshMultisigProposal,
  registerMultisigAccount,
  removeMultisigDraftMember,
  updateMultisigDraftThreshold,
} from '../backend'
import {
  addMultisigPendingInvite,
  clearMultisigDraftMeta,
  createMultisigAccount,
  dismissMultisigProposalsBanner,
  getMultisigDraftMeta,
  getMultisigPendingInvites,
  getMultisigProposalsBannerDismissed,
  removeMultisigPendingInvite,
  setMultisigDraftMeta,
} from '../storage'
import { addExistingMultisigAccount } from './addExistingAccount'
import {
  ensureMultisigAccountRegisteredForSession,
  syncLocalMultisigAccountsFromBackend,
} from './syncLocalAccounts'
import type { OkFn } from '../messageResponse'

/** Returns true if the message type was handled. */
export async function tryHandleMultisigMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
): Promise<boolean> {
  switch (message.type) {
    case 'MULTISIG_CREATE_DRAFT': {
      const data = await createMultisigDraft()
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_GET_ACTIVE_DRAFT': {
      const data = await getActiveMultisigDraft()
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_ADD_DRAFT_MEMBER': {
      const req = message.payload as {
        draftId: string
        member: import('@latch/types').MultisigDraftMemberRequest
      }
      const data = await addMultisigDraftMember(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_REMOVE_DRAFT_MEMBER': {
      const req = message.payload as { draftId: string; memberId: string }
      const data = await removeMultisigDraftMember(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_UPDATE_DRAFT_THRESHOLD': {
      const req = message.payload as { draftId: string; threshold: number }
      const data = await updateMultisigDraftThreshold(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_PREDICT_DRAFT': {
      const req = message.payload as { draftId: string }
      const data = await predictMultisigDraftAddress(req.draftId)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_DEPLOY_DRAFT': {
      const req = message.payload as { draftId: string }
      const data = await deployMultisigDraft(req.draftId)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_DRAFT_PASSKEY_REG_BEGIN': {
      const req = message.payload as { draftId: string; displayName?: string }
      const data = await multisigDraftPasskeyRegBegin(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_DRAFT_PASSKEY_REG_FINISH': {
      const req = message.payload as { draftId: string; response: unknown }
      const data = await multisigDraftPasskeyRegFinish(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_DRAFT_PASSKEY_AUTH_BEGIN': {
      const req = message.payload as { draftId: string; displayName?: string }
      const data = await multisigDraftPasskeyAuthBegin(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_DRAFT_PASSKEY_AUTH_FINISH': {
      const req = message.payload as { draftId: string; response: unknown }
      const data = await multisigDraftPasskeyAuthFinish(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_LIST_ACCOUNTS': {
      const data = await listMultisigAccounts()
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_REGISTER_ACCOUNT': {
      const req = message.payload as import('@latch/types').RegisterMultisigAccountRequest
      const data = await registerMultisigAccount(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_ADD_EXISTING_ACCOUNT': {
      const req = message.payload as import('@latch/types').AddExistingMultisigAccountRequest
      const data = await addExistingMultisigAccount(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_JOIN_PREVIEW': {
      const req = message.payload as { token: string }
      const data = await getMultisigDraftByInviteToken(req.token)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_JOIN_MEMBER': {
      const req = message.payload as {
        token: string
        member: import('@latch/types').MultisigDraftMemberRequest
      }
      const data = await joinMultisigDraft(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_JOIN_PASSKEY_REG_BEGIN': {
      const req = message.payload as { token: string; displayName?: string }
      const data = await multisigJoinPasskeyRegBegin(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_JOIN_PASSKEY_REG_FINISH': {
      const req = message.payload as { token: string; response: unknown }
      const data = await multisigJoinPasskeyRegFinish(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_JOIN_PASSKEY_AUTH_BEGIN': {
      const req = message.payload as { token: string; displayName?: string }
      const data = await multisigJoinPasskeyAuthBegin(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_JOIN_PASSKEY_AUTH_FINISH': {
      const req = message.payload as { token: string; response: unknown }
      const data = await multisigJoinPasskeyAuthFinish(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_LIST_PROPOSALS': {
      const req = message.payload as { smartAccountAddress: string }
      await ensureMultisigAccountRegisteredForSession(req.smartAccountAddress)
      const data = await listMultisigProposals(req.smartAccountAddress)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_GET_PROPOSAL': {
      const req = message.payload as { proposalId: string }
      const data = await getMultisigProposal(req.proposalId)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_CREATE_PROPOSAL': {
      const req = message.payload as import('@latch/types').CreateMultisigProposalRequest
      await ensureMultisigAccountRegisteredForSession(req.smartAccountAddress)
      const data = await createMultisigProposal(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_APPROVE_DELEGATED_BEGIN': {
      const req = message.payload as { proposalId: string; memberId: string }
      const data = await multisigProposalApproveDelegatedBegin(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_APPROVE_DELEGATED_FINISH': {
      const req = message.payload as import('@latch/types').MultisigApproveDelegatedFinishRequest
      const data = await multisigProposalApproveDelegatedFinish(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_APPROVE_WEBAUTHN': {
      const req = message.payload as import('@latch/types').MultisigApproveWebauthnRequest
      const data = await multisigProposalApproveWebauthn(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_EXECUTE_PROPOSAL': {
      const req = message.payload as { proposalId: string }
      const data = await executeMultisigProposal(req.proposalId)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_REFRESH_PROPOSAL': {
      const req = message.payload as { proposalId: string }
      const data = await refreshMultisigProposal(req.proposalId)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_CREATE_LOCAL_ACCOUNT': {
      const req = message.payload as import('@latch/types').CreateMultisigAccountParams
      const result = await createMultisigAccount(req)
      sendResponse(ok(result))
      return true
    }
    case 'MULTISIG_GET_PENDING_INVITES': {
      const invites = await getMultisigPendingInvites()
      sendResponse(ok({ invites }))
      return true
    }
    case 'MULTISIG_ADD_PENDING_INVITE': {
      const invite = message.payload as import('@latch/types').MultisigPendingInvite
      const invites = await addMultisigPendingInvite(invite)
      sendResponse(ok({ invites }))
      return true
    }
    case 'MULTISIG_REMOVE_PENDING_INVITE': {
      const req = message.payload as { token: string }
      const invites = await removeMultisigPendingInvite(req.token)
      sendResponse(ok({ invites }))
      return true
    }
    case 'MULTISIG_GET_DRAFT_META': {
      const meta = await getMultisigDraftMeta()
      sendResponse(ok({ meta }))
      return true
    }
    case 'MULTISIG_SET_DRAFT_META': {
      const meta = message.payload as import('@latch/types').MultisigDraftMeta
      await setMultisigDraftMeta(meta)
      sendResponse(ok())
      return true
    }
    case 'MULTISIG_CLEAR_DRAFT_META': {
      await clearMultisigDraftMeta()
      sendResponse(ok())
      return true
    }
    case 'MULTISIG_SYNC_LOCAL_ACCOUNTS': {
      const req = (message.payload ?? {}) as { activateFirstCreated?: boolean }
      const data = await syncLocalMultisigAccountsFromBackend(req)
      sendResponse(ok(data))
      return true
    }
    case 'MULTISIG_GET_PROPOSALS_BANNER_DISMISSED': {
      const accountIds = await getMultisigProposalsBannerDismissed()
      sendResponse(ok({ accountIds }))
      return true
    }
    case 'MULTISIG_DISMISS_PROPOSALS_BANNER': {
      const req = message.payload as { accountId: string }
      const accountIds = await dismissMultisigProposalsBanner(req.accountId)
      sendResponse(ok({ accountIds }))
      return true
    }
    default:
      return false
  }
}
