import type {
  BackendWebauthnBeginResponse,
  BackendWebauthnRegistrationFinishRequest,
  BackendWebauthnRegistrationFinishResponse,
  MultisigDraft,
  MultisigDraftMemberRequest,
  StoredAccount,
} from '@latch/types'
import {
  assertBeginOptionsRpIdMatchesCanonicalDomain,
  assertRegistrationCeremonyForFinish,
  enrichWebauthnRpIdHashErrorMessage,
  formatWebauthnBrowserError,
  narrowAuthenticationOptionsToCredential,
  prepareRegistrationOptionsForCreate,
} from '../webauthn/passkey'
import { reservePasskeyName } from '../webauthn/passkeyName'
import { runWebauthnCredential } from '../webauthn/runWebauthnCredential'

import { friendlyError, sendToBackground } from './backgroundClient'
import {
  apiAddDraftMember,
  apiDraftPasskeyAuthBegin,
  apiDraftPasskeyAuthFinish,
  apiDraftPasskeyRegBegin,
  apiDraftPasskeyRegFinish,
  apiJoinMember,
  apiJoinPasskeyAuthBegin,
  apiJoinPasskeyAuthFinish,
  apiJoinPasskeyRegBegin,
  apiJoinPasskeyRegFinish,
} from './multisigFlow'

export function listReusablePasskeyAccounts(accounts: StoredAccount[]): StoredAccount[] {
  return accounts.filter(
    (a) =>
      a.mode === 'passkey' &&
      Boolean(a.passkeyCredentialId?.trim()) &&
      Boolean(a.passkeyKeyDataHex?.trim())
  )
}

export function findReusablePasskeyAccount(accounts: StoredAccount[]): StoredAccount | undefined {
  return listReusablePasskeyAccounts(accounts)[0]
}

/** Register a new passkey for cosign multisig create (no `/api/multisig/drafts` ceremony). */
export async function enrollNewPasskeyForCosignWizard(args: {
  accounts: StoredAccount[]
  label: string
  surface: 'popup' | 'sidepanel'
}): Promise<StoredAccount> {
  const reserved = await reservePasskeyName({
    accountLabel: args.label,
    context: 'multisig',
    fallbackAccounts: args.accounts,
  })
  const displayName = reserved.displayName
  const begin = await sendToBackground<{ displayName?: string }, BackendWebauthnBeginResponse>({
    type: 'PASSKEY_REG_BEGIN',
    payload: { displayName },
  })
  if (!begin.ok || !begin.data) throw new Error(friendlyError(begin.error))
  const optionsJSON = prepareRegistrationOptionsForCreate(begin.data.options, displayName)
  assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
  let registration: unknown
  try {
    registration = await runWebauthnRegistration(args.surface, optionsJSON)
  } catch (e) {
    throw new Error(formatWebauthnBrowserError(e))
  }
  assertRegistrationCeremonyForFinish(registration)
  const finish = await sendToBackground<
    BackendWebauthnRegistrationFinishRequest,
    BackendWebauthnRegistrationFinishResponse & { account: StoredAccount }
  >({
    type: 'PASSKEY_REG_FINISH',
    payload: { response: registration, displayName, seq: reserved.seq },
  })
  if (!finish.ok || !finish.data?.account) {
    const errMsg = friendlyError(finish.error)
    throw new Error(
      await enrichWebauthnRpIdHashErrorMessage(errMsg, {
        optionsJSON,
        credentialResponse: registration,
      })
    )
  }
  await reserved.commit()
  return finish.data.account
}

async function runWebauthnRegistration(
  surface: 'popup' | 'sidepanel',
  optionsJSON: unknown
): Promise<unknown> {
  return await runWebauthnCredential(surface, 'registration', optionsJSON)
}

async function runWebauthnAuthentication(
  surface: 'popup' | 'sidepanel',
  optionsJSON: unknown
): Promise<unknown> {
  return await runWebauthnCredential(surface, 'authentication', optionsJSON)
}

function passkeyMemberFromAccount(
  account: StoredAccount,
  label: string
): MultisigDraftMemberRequest {
  const credentialId = account.passkeyCredentialId?.trim()
  const keyDataHex = account.passkeyKeyDataHex?.trim()
  if (!credentialId || !keyDataHex) {
    throw new Error('Passkey account is missing credential data.')
  }
  return {
    label,
    memberType: 'passkey',
    credentialId,
    keyDataHex,
  }
}

/** Add a known local passkey to a draft without a WebAuthn ceremony. */
export async function addStoredPasskeyToDraft(args: {
  draftId: string
  account: StoredAccount
  label: string
}): Promise<MultisigDraft> {
  return apiAddDraftMember(args.draftId, passkeyMemberFromAccount(args.account, args.label))
}

/** Add a known local passkey to a join draft without a WebAuthn ceremony. */
export async function addStoredPasskeyToJoin(args: {
  token: string
  account: StoredAccount
  label: string
}): Promise<{ draft: MultisigDraft; credentialId: string }> {
  const member = passkeyMemberFromAccount(args.account, args.label)
  const draft = await apiJoinMember(args.token, member)
  return { draft, credentialId: member.credentialId! }
}

export async function enrollExistingPasskeyForDraft(args: {
  draftId: string
  account: StoredAccount
  label: string
  surface: 'popup' | 'sidepanel'
}): Promise<MultisigDraft> {
  const member = passkeyMemberFromAccount(args.account, args.label)
  const begin = await apiDraftPasskeyAuthBegin(args.draftId, args.label)
  assertBeginOptionsRpIdMatchesCanonicalDomain(begin.options)
  const narrowed = narrowAuthenticationOptionsToCredential(begin.options, member.credentialId!)
  let assertion: unknown
  try {
    assertion = await runWebauthnAuthentication(args.surface, narrowed)
  } catch (e) {
    throw new Error(formatWebauthnBrowserError(e))
  }
  await apiDraftPasskeyAuthFinish(args.draftId, assertion)
  return apiAddDraftMember(args.draftId, member)
}

export async function enrollNewPasskeyForDraft(args: {
  draftId: string
  label: string
  /** Wallet name folded into the passkey label; defaults to the member label. */
  accountLabel?: string
  accounts?: StoredAccount[]
  surface: 'popup' | 'sidepanel'
}): Promise<{ draft: MultisigDraft; credentialId: string }> {
  const reserved = await reservePasskeyName({
    accountLabel: args.accountLabel ?? args.label,
    context: 'multisig',
    fallbackAccounts: args.accounts,
  })
  const begin = await apiDraftPasskeyRegBegin(args.draftId, reserved.displayName)
  assertBeginOptionsRpIdMatchesCanonicalDomain(begin.options)
  let assertion: unknown
  try {
    assertion = await runWebauthnRegistration(args.surface, begin.options)
  } catch (e) {
    throw new Error(formatWebauthnBrowserError(e))
  }
  const cred = await apiDraftPasskeyRegFinish(args.draftId, assertion)
  await reserved.commit()
  const draft = await apiAddDraftMember(args.draftId, {
    label: args.label,
    memberType: 'passkey',
    credentialId: cred.credentialId,
    keyDataHex: cred.keyDataHex,
  })
  return { draft, credentialId: cred.credentialId }
}

export async function enrollExistingPasskeyForJoin(args: {
  token: string
  account: StoredAccount
  label: string
  surface: 'popup' | 'sidepanel'
}): Promise<{ draft: MultisigDraft; credentialId: string }> {
  const member = passkeyMemberFromAccount(args.account, args.label)
  const begin = await apiJoinPasskeyAuthBegin(args.token, args.label)
  assertBeginOptionsRpIdMatchesCanonicalDomain(begin.options)
  const narrowed = narrowAuthenticationOptionsToCredential(begin.options, member.credentialId!)
  let assertion: unknown
  try {
    assertion = await runWebauthnAuthentication(args.surface, narrowed)
  } catch (e) {
    throw new Error(formatWebauthnBrowserError(e))
  }
  await apiJoinPasskeyAuthFinish(args.token, assertion)
  const draft = await apiJoinMember(args.token, member)
  return { draft, credentialId: member.credentialId! }
}

export async function enrollNewPasskeyForJoin(args: {
  token: string
  label: string
  /** Wallet name folded into the passkey label, when the invite carries one. */
  accountLabel?: string
  accounts?: StoredAccount[]
  surface: 'popup' | 'sidepanel'
}): Promise<{ draft: MultisigDraft; credentialId: string }> {
  const reserved = await reservePasskeyName({
    accountLabel: args.accountLabel,
    context: 'multisig join',
    fallbackAccounts: args.accounts,
  })
  const begin = await apiJoinPasskeyRegBegin(args.token, reserved.displayName)
  assertBeginOptionsRpIdMatchesCanonicalDomain(begin.options)
  let assertion: unknown
  try {
    assertion = await runWebauthnRegistration(args.surface, begin.options)
  } catch (e) {
    throw new Error(formatWebauthnBrowserError(e))
  }
  const cred = await apiJoinPasskeyRegFinish(args.token, assertion)
  await reserved.commit()
  const draft = await apiJoinMember(args.token, {
    label: args.label,
    memberType: 'passkey',
    credentialId: cred.credentialId,
    keyDataHex: cred.keyDataHex,
  })
  return { draft, credentialId: cred.credentialId }
}
