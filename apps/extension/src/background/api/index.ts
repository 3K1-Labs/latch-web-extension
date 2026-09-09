export { DEFAULT_LATCH_API_URL, latchApiBaseUrl, latchMarketApiBaseUrl } from './config'
export { parseApiError } from './errors'
export { BackendError, latchFetch, latchFetchAbsolute } from './client'
export {
  passkeyRegistrationBegin,
  passkeyRegistrationFinish,
  passkeyAuthenticationBegin,
  passkeyAuthenticationFinish,
  webauthnBeginBody,
  webauthnFinishBody,
  latchExtensionJsonBody,
} from './webauthn'
export { getBackendAccounts, setBackendActiveAccount } from './accounts'
export { clearLatchApiSession } from './webauthnSession'
export {
  getFreighterSmartAccountStatus,
  createOrConnectFreighter,
  ensureFreighterSmartAccountDeployed,
  createOrConnectPasskey,
  ensurePasskeySmartAccountDeployed,
} from './smartAccount'
export {
  buildSendTx,
  buildSwapTx,
  setupSendRules,
  setupSwapRules,
  buildTx,
  buildDelegatedTx,
  submitTxDelegated,
  submitTxWebauthn,
  prepareSign,
} from './transactions'
export { fetchSignPayload } from './signPayload'
export {
  fetchMarketPricesNormalized,
  normalizeMarketPricesData,
  type NormalizedTokenPrice,
} from './market'
export {
  listMultisigAccounts,
  predictMultisigAccountFromSigners,
  deployMultisigAccount,
  registerMultisigAccount,
} from './multisigAccounts'
export {
  createMultisigDraft,
  getActiveMultisigDraft,
  getMultisigDraft,
  updateMultisigDraftThreshold,
  addMultisigDraftMember,
  removeMultisigDraftMember,
  predictMultisigDraftAddress,
  deployMultisigDraft,
  multisigDraftPasskeyRegBegin,
  multisigDraftPasskeyRegFinish,
  multisigDraftPasskeyAuthBegin,
  multisigDraftPasskeyAuthFinish,
} from './multisigDrafts'
export {
  getMultisigDraftByInviteToken,
  joinMultisigDraft,
  multisigJoinPasskeyRegBegin,
  multisigJoinPasskeyRegFinish,
  multisigJoinPasskeyAuthBegin,
  multisigJoinPasskeyAuthFinish,
} from './multisigJoin'
export {
  listMultisigProposals,
  createMultisigProposal,
  getMultisigProposal,
  multisigProposalApproveDelegatedBegin,
  multisigProposalApproveDelegatedFinish,
  multisigProposalApproveWebauthn,
  executeMultisigProposal,
  refreshMultisigProposal,
} from './multisigProposals'
export { createDepositIntent, fetchDepositIntentStatus } from './deposit'
