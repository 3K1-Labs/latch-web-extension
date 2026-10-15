import type {
  MultisigAccount,
  MultisigDraft,
  MultisigDraftMember,
  MultisigDraftMeta,
  MultisigPendingInvite,
  MultisigPredictResponse,
  StoredAccount,
} from '@latch/types'

import {
  clearLatchApiSession,
  getActiveMultisigDraft,
  getMultisigDraft,
  getMultisigDraftByInviteToken,
  listMultisigAccounts,
  predictMultisigAccountFromSigners,
  predictMultisigDraftAddress,
  registerMultisigAccount,
} from '../backend'
import {
  findMemberIdForUser,
  passkeyCredentialIdsFromAccounts,
  resolveDraftMembership,
} from '../../lib/multisigMemberMatch'
import {
  createMultisigAccount,
  getAccounts,
  getMultisigDraftMeta,
  getMultisigPendingInvites,
  getRemovedAccountAddresses,
  removeMultisigPendingInvite,
  setActiveAccount,
  upsertMultisigPendingInvite,
} from '../storage'
import {
  draftLooksDeployed,
  draftMembersToRegisterMembers,
  draftMembersToSigners,
  isRegisterDuplicateError,
  matchPendingInviteForRemoteAccount,
  localSignerAccounts,
  multisigLocalAccountNeedsUpdate,
  normalizeListMultisigAccountsResponse,
  predictAddress,
  predictSalt,
  remoteMultisigMatchesLocalSigner,
  resolveRemoteMemberId,
} from './syncHelpers'

type SyncContext = {
  localAccounts: StoredAccount[]
  activeAccountId?: string
  created: StoredAccount[]
  updated: boolean
  pendingInvites: MultisigPendingInvite[]
  passkeyCredentialIds: Set<string>
  /** Addresses the user removed on this install; never re-import them. */
  removedAddresses: Set<string>
}

/** Normalize cached member snapshots (draft API or unwired cosign) for register+local sync. */
function coerceMembersSnapshotToDraftMembers(
  snapshot: MultisigDraftMember[] | import('@latch/types').CosignMemberInit[] | undefined | null
): MultisigDraftMember[] {
  if (!snapshot?.length) return []
  return snapshot.map((m, i) => {
    if (m && typeof m === 'object' && ('memberType' in m || 'id' in m)) {
      return m as MultisigDraftMember
    }
    const c = m as import('@latch/types').CosignMemberInit
    const type = c.type?.trim().toLowerCase() ?? ''
    const memberType =
      type === 'webauthn' || type === 'passkey'
        ? 'passkey'
        : type === 'delegated' || type === 'seed'
          ? 'seed'
          : type || 'passkey'
    return {
      id: `snapshot-${i}`,
      memberType,
      label: c.label,
      gAddress: c.gAddress,
      keyDataHex: c.keyDataHex,
    }
  })
}

async function findListedMultisigAccount(
  smartAccountAddress: string
): Promise<MultisigAccount | undefined> {
  const addr = smartAccountAddress.trim()
  if (!addr) return undefined
  const listed = normalizeListMultisigAccountsResponse(await listMultisigAccounts())
  return listed.find((a) => a.smartAccountAddress?.trim() === addr)
}

async function refreshLocalMultisigFromRemote(
  smartAccountAddress: string,
  remote: MultisigAccount
): Promise<void> {
  const { accounts } = await getAccounts()
  const addr = smartAccountAddress.trim()
  const local = accounts.find((a) => a.mode === 'multisig' && a.smartAccountAddress.trim() === addr)
  if (!local) return

  const memberId = resolveRemoteMemberId(remote, accounts) ?? local.multisigMemberId
  const needsUpdate =
    (memberId && memberId !== local.multisigMemberId) ||
    (remote.id && remote.id !== local.multisigBackendAccountId) ||
    (remote.threshold != null && remote.threshold !== local.multisigThreshold) ||
    (remote.label?.trim() && remote.label.trim() !== local.label)

  if (!needsUpdate) return

  await createMultisigAccount({
    smartAccountAddress: local.smartAccountAddress,
    label: remote.label?.trim() ?? local.label,
    multisigThreshold: remote.threshold ?? local.multisigThreshold,
    multisigMemberId: memberId,
    multisigBackendAccountId: remote.id ?? local.multisigBackendAccountId,
    multisigAccountSaltHex: local.multisigAccountSaltHex,
    multisigMembersSnapshot: local.multisigMembersSnapshot,
  })
}

/** Ensure the backend knows this multisig for the current session (required before proposals). */
export async function ensureMultisigAccountRegisteredForSession(
  smartAccountAddress: string
): Promise<MultisigAccount> {
  const addr = smartAccountAddress.trim()
  if (!addr) throw new Error('Missing multisig smart account address.')

  let remote = await findListedMultisigAccount(addr)
  if (remote) {
    await refreshLocalMultisigFromRemote(addr, remote)
    return remote
  }

  await syncLocalMultisigAccountsFromBackend()

  remote = await findListedMultisigAccount(addr)
  if (remote) {
    await refreshLocalMultisigFromRemote(addr, remote)
    return remote
  }

  // Last resort: register directly from the cached member snapshot, deriving salt via predict.
  const { accounts } = await getAccounts()
  const pendingInvites = await getMultisigPendingInvites()
  const local = accounts.find((a) => a.mode === 'multisig' && a.smartAccountAddress.trim() === addr)
  const invite = pendingInvites.find((i) => i.smartAccountAddress?.trim() === addr)

  const threshold = invite?.threshold ?? local?.multisigThreshold
  const membersRaw =
    (invite?.membersSnapshot?.length ? invite.membersSnapshot : local?.multisigMembersSnapshot) ??
    []
  const members = coerceMembersSnapshotToDraftMembers(membersRaw)
  const cachedSaltHex = invite?.accountSaltHex?.trim() ?? local?.multisigAccountSaltHex?.trim()

  const usedSaltHex = await registerMultisigForSession({
    smartAccountAddress: addr,
    threshold,
    members,
    accountSaltHex: cachedSaltHex,
    localAccounts: accounts,
  })

  // Cache the salt we derived so future ensures are instant and offline-tolerant.
  if (usedSaltHex && local && usedSaltHex !== local.multisigAccountSaltHex) {
    await createMultisigAccount({
      smartAccountAddress: addr,
      label: local.label,
      multisigThreshold: local.multisigThreshold,
      multisigMemberId: local.multisigMemberId,
      multisigBackendAccountId: local.multisigBackendAccountId,
      multisigAccountSaltHex: usedSaltHex,
      multisigMembersSnapshot: local.multisigMembersSnapshot ?? members,
    })
  }

  remote = await findListedMultisigAccount(addr)
  if (remote) {
    await refreshLocalMultisigFromRemote(addr, remote)
    return remote
  }

  if (members.length === 0) {
    throw new Error(
      'This multisig wallet is not linked to your Latch session and no member details are cached. Open your invite link again to re-sync.'
    )
  }
  throw new Error(
    'This multisig wallet could not be linked to your Latch session. Make sure you joined this wallet before it was deployed, then reopen your invite link.'
  )
}

async function ensureLocalMultisigAccount(
  ctx: SyncContext,
  args: {
    smartAccountAddress: string
    label: string
    threshold?: number
    memberId?: string
    backendAccountId?: string
    accountSaltHex?: string
    membersSnapshot?: MultisigDraftMember[]
  }
): Promise<void> {
  const addr = args.smartAccountAddress.trim()
  if (!addr) return

  const existing = ctx.localAccounts.find(
    (a) => a.mode === 'multisig' && a.smartAccountAddress === addr
  )
  // Backstop for every sync path: a wallet the user removed here stays removed
  // until they add it back explicitly.
  if (!existing && ctx.removedAddresses.has(addr)) return

  // Remote list responses may omit `label` (or older deployments might not have one),
  // but we still want to preserve any local user-assigned label.
  const desiredLabel = args.label.trim()
  const label = desiredLabel || existing?.label?.trim() || 'Multisig wallet'
  if (existing) {
    if (
      !multisigLocalAccountNeedsUpdate(existing, {
        label,
        threshold: args.threshold,
        memberId: args.memberId,
        backendAccountId: args.backendAccountId,
      })
    ) {
      return
    }

    const { account } = await createMultisigAccount({
      smartAccountAddress: addr,
      label,
      multisigThreshold: args.threshold ?? existing.multisigThreshold,
      multisigMemberId: args.memberId ?? existing.multisigMemberId,
      multisigBackendAccountId: args.backendAccountId ?? existing.multisigBackendAccountId,
      multisigAccountSaltHex: args.accountSaltHex ?? existing.multisigAccountSaltHex,
      multisigMembersSnapshot:
        args.membersSnapshot ??
        coerceMembersSnapshotToDraftMembers(existing.multisigMembersSnapshot),
    })
    ctx.localAccounts = ctx.localAccounts.map((a) => (a.id === account.id ? account : a))
    ctx.updated = true
    return
  }

  const { account } = await createMultisigAccount({
    smartAccountAddress: addr,
    label,
    multisigThreshold: args.threshold,
    multisigMemberId: args.memberId,
    multisigBackendAccountId: args.backendAccountId,
    multisigAccountSaltHex: args.accountSaltHex,
    multisigMembersSnapshot: args.membersSnapshot,
  })
  ctx.created.push(account)
  ctx.localAccounts = [...ctx.localAccounts, account]
  ctx.updated = true
}

async function predictDeployInfo(args: {
  draft?: MultisigDraft | null
  members: MultisigDraftMember[]
  threshold?: number
  draftId?: string
}): Promise<MultisigPredictResponse | null> {
  if (args.draftId) {
    try {
      return await predictMultisigDraftAddress(args.draftId)
    } catch {
      // fall through to signer-based predict
    }
  }
  const threshold = args.threshold ?? args.draft?.threshold
  const members = args.members.length > 0 ? args.members : (args.draft?.members ?? [])
  if (!threshold || members.length === 0) return null
  try {
    return await predictMultisigAccountFromSigners({
      threshold,
      signers: draftMembersToSigners(members),
    })
  } catch {
    return null
  }
}

/**
 * Derive `accountSaltHex` deterministically from the member snapshot when it isn't cached.
 * The deployed address + salt are a pure function of (threshold, ordered signer set), so predict
 * lets a member reconstruct them post-deploy without the join preview (which 404s after deploy).
 */
async function resolveAccountSaltHex(args: {
  smartAccountAddress: string
  threshold?: number
  members: MultisigDraftMember[]
  cachedSaltHex?: string
}): Promise<string | undefined> {
  const cached = args.cachedSaltHex?.trim()
  if (cached) return cached
  if (!args.threshold || args.members.length === 0) return undefined
  try {
    const predict = await predictMultisigAccountFromSigners({
      threshold: args.threshold,
      signers: draftMembersToSigners(args.members),
    })
    const predictedAddr = predict.smartAccountAddress?.trim()
    // Only trust the derived salt if the predicted address matches the target (snapshot is complete).
    if (predictedAddr && predictedAddr !== args.smartAccountAddress.trim()) return undefined
    return predict.accountSaltHex?.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Register a deployed multisig for the current session so `GET /api/multisig/accounts` and
 * `/proposals` stop returning `unknown multisig account`. Derives salt via predict when missing.
 * Returns the salt used (for caching), or undefined when registration could not be attempted.
 */
async function registerMultisigForSession(args: {
  smartAccountAddress: string
  threshold?: number
  members: MultisigDraftMember[]
  accountSaltHex?: string
  localAccounts: StoredAccount[]
}): Promise<string | undefined> {
  const addr = args.smartAccountAddress.trim()
  if (!addr || !args.threshold || args.members.length === 0) return args.accountSaltHex?.trim()

  const accountSaltHex = await resolveAccountSaltHex({
    smartAccountAddress: addr,
    threshold: args.threshold,
    members: args.members,
    cachedSaltHex: args.accountSaltHex,
  })
  if (!accountSaltHex) return undefined

  try {
    await registerMultisigAccount({
      smartAccountAddress: addr,
      threshold: args.threshold,
      accountSaltHex,
      members: draftMembersToRegisterMembers(args.members, args.localAccounts),
    })
  } catch (err) {
    if (!isRegisterDuplicateError(err)) throw err
  }
  return accountSaltHex
}

function labelForInvite(invite: MultisigPendingInvite, draft?: MultisigDraft | null): string {
  if (invite.walletName?.trim()) return invite.walletName.trim()
  const draftName = (draft as { walletName?: string } | undefined)?.walletName?.trim()
  if (draftName) return draftName
  return 'Multisig wallet'
}

function localMultisigExists(ctx: SyncContext, smartAccountAddress?: string): boolean {
  const addr = smartAccountAddress?.trim()
  if (!addr) return false
  return ctx.localAccounts.some((a) => a.mode === 'multisig' && a.smartAccountAddress === addr)
}

async function clearPendingInvite(ctx: SyncContext, token: string): Promise<void> {
  await removeMultisigPendingInvite(token)
  ctx.pendingInvites = ctx.pendingInvites.filter((i) => i.token !== token)
}

async function syncFromMembershipDraft(
  ctx: SyncContext,
  args: {
    members: MultisigDraftMember[]
    threshold?: number
    draft?: MultisigDraft | null
    draftId?: string
    label: string
    inviteToken?: string
    inviteMemberId?: string
    passkeyCredentialId?: string
    cachedSmartAccountAddress?: string
    cachedAccountSaltHex?: string
    predict?: MultisigPredictResponse | null
  }
): Promise<boolean> {
  const membership = resolveDraftMembership(args.members, ctx.localAccounts, {
    passkeyCredentialId: args.passkeyCredentialId,
    multisigMemberId: args.inviteMemberId,
  })
  if (!membership) return false

  const predict =
    args.predict ??
    (await predictDeployInfo({
      draft: args.draft,
      members: args.members,
      threshold: args.threshold,
      draftId: args.draftId ?? args.draft?.id,
    }))

  const smartAccountAddress = predictAddress(args.draft, predict, args.cachedSmartAccountAddress)
  const accountSaltHex = predictSalt(args.draft, predict, args.cachedAccountSaltHex)
  const threshold = args.threshold ?? args.draft?.threshold
  if (!smartAccountAddress || !threshold) return false

  const memberId =
    args.inviteMemberId ??
    membership.member.id ??
    findMemberIdForUser(args.members, ctx.localAccounts, args.inviteMemberId)

  const deployed = draftLooksDeployed(args.draft, predict)
  if (!deployed) return true

  const usedSaltHex =
    (await registerMultisigForSession({
      smartAccountAddress,
      threshold,
      members: args.members,
      accountSaltHex,
      localAccounts: ctx.localAccounts,
    })) ?? accountSaltHex

  await ensureLocalMultisigAccount(ctx, {
    smartAccountAddress,
    label: args.label,
    threshold,
    memberId,
    accountSaltHex: usedSaltHex,
    membersSnapshot: args.members,
  })

  // Only clear the invite once the backend confirms this session is a member.
  const listed = await findListedMultisigAccount(smartAccountAddress)
  if (listed && args.inviteToken) await clearPendingInvite(ctx, args.inviteToken)

  return true
}

async function syncFromPendingInvite(
  ctx: SyncContext,
  invite: MultisigPendingInvite
): Promise<void> {
  const inviteAddr = invite.smartAccountAddress?.trim()
  if (inviteAddr && localMultisigExists(ctx, inviteAddr)) {
    // Local wallet exists but this session may still be unknown to the backend — register it.
    if (invite.threshold && invite.membersSnapshot?.length) {
      const usedSaltHex = await registerMultisigForSession({
        smartAccountAddress: inviteAddr,
        threshold: invite.threshold,
        members: invite.membersSnapshot,
        accountSaltHex: invite.accountSaltHex,
        localAccounts: ctx.localAccounts,
      })
      if (usedSaltHex && usedSaltHex !== invite.accountSaltHex) {
        await upsertMultisigPendingInvite(invite.token, { accountSaltHex: usedSaltHex })
      }
    }
    const listed = await findListedMultisigAccount(inviteAddr)
    if (listed) await clearPendingInvite(ctx, invite.token)
    return
  }

  let preview: Awaited<ReturnType<typeof getMultisigDraftByInviteToken>> | null = null
  try {
    preview = await getMultisigDraftByInviteToken(invite.token)
  } catch {
    preview = null
  }

  const draft = preview?.draft ?? null
  const members = preview?.members ?? draft?.members ?? invite.membersSnapshot ?? []
  const threshold = preview?.threshold ?? draft?.threshold ?? invite.threshold
  const draftId = draft?.id ?? invite.draftId
  const membership = resolveDraftMembership(members, ctx.localAccounts, {
    passkeyCredentialId: invite.passkeyCredentialId,
    multisigMemberId: invite.multisigMemberId,
  })

  if (membership || invite.multisigMemberId) {
    await upsertMultisigPendingInvite(invite.token, {
      walletName: invite.walletName ?? labelForInvite(invite, draft),
      draftId,
      multisigMemberId: invite.multisigMemberId ?? membership?.member.id,
      passkeyCredentialId:
        invite.passkeyCredentialId ?? membership?.account?.passkeyCredentialId?.trim(),
      threshold,
      membersSnapshot: members,
      smartAccountAddress: draft?.smartAccountAddress ?? invite.smartAccountAddress,
      accountSaltHex:
        (draft as { accountSaltHex?: string } | undefined)?.accountSaltHex ?? invite.accountSaltHex,
    })
  }

  if (!membership && !invite.multisigMemberId) return

  const predict = await predictDeployInfo({ draft, members, threshold, draftId })
  const cachedSmartAccountAddress = predictAddress(draft, predict, invite.smartAccountAddress)
  const cachedAccountSaltHex = predictSalt(draft, predict, invite.accountSaltHex)

  if (cachedSmartAccountAddress || cachedAccountSaltHex) {
    await upsertMultisigPendingInvite(invite.token, {
      smartAccountAddress: cachedSmartAccountAddress,
      accountSaltHex: cachedAccountSaltHex,
      threshold,
      membersSnapshot: members,
      draftId,
    })
  }

  await syncFromMembershipDraft(ctx, {
    members,
    threshold,
    draft,
    draftId,
    label: labelForInvite(invite, draft),
    inviteToken: invite.token,
    inviteMemberId: invite.multisigMemberId ?? membership?.member.id,
    passkeyCredentialId: invite.passkeyCredentialId,
    cachedSmartAccountAddress,
    cachedAccountSaltHex,
    predict,
  })
}

async function syncFromCreatorDraftMeta(ctx: SyncContext, meta: MultisigDraftMeta): Promise<void> {
  let draft: MultisigDraft | null = null
  try {
    const active = await getActiveMultisigDraft()
    if (active.draft?.id === meta.draftId) {
      draft = active.draft
    }
  } catch {
    // ignore
  }
  if (!draft) {
    try {
      draft = await getMultisigDraft(meta.draftId)
    } catch {
      return
    }
  }

  const members = draft.members ?? []
  await syncFromMembershipDraft(ctx, {
    members,
    threshold: draft.threshold,
    draft,
    draftId: draft.id,
    label: meta.walletName?.trim() || 'Multisig wallet',
    inviteToken: meta.inviteToken,
    cachedSmartAccountAddress: draft.smartAccountAddress,
    cachedAccountSaltHex: (draft as { accountSaltHex?: string }).accountSaltHex,
  })
}

async function importListedRemoteAccounts(ctx: SyncContext): Promise<void> {
  const listed = normalizeListMultisigAccountsResponse(await listMultisigAccounts())

  for (const remote of listed) {
    const addr = remote.smartAccountAddress?.trim()
    if (!addr) continue
    if (ctx.removedAddresses.has(addr)) continue

    const matchedInvite = matchPendingInviteForRemoteAccount(
      remote,
      ctx.pendingInvites,
      ctx.passkeyCredentialIds
    )

    // Listed-for-this-session is not proof of membership: the API also returns
    // wallets the session user only created. Require a signer match, or a
    // pending invite this install started, before importing.
    if (!matchedInvite && !remoteMultisigMatchesLocalSigner(remote, ctx.localAccounts)) {
      continue
    }

    const memberId = resolveRemoteMemberId(
      remote,
      ctx.localAccounts,
      matchedInvite?.multisigMemberId
    )
    // Only trust labels that are tied to this specific remote account (remote.label or matched invite).
    // If neither is present, preserve any existing local label (handled in `ensureLocalMultisigAccount`).
    const label = remote.label?.trim() ?? matchedInvite?.walletName?.trim() ?? ''

    await ensureLocalMultisigAccount(ctx, {
      smartAccountAddress: addr,
      label,
      threshold: remote.threshold,
      memberId,
      backendAccountId: remote.id,
      accountSaltHex: matchedInvite?.accountSaltHex,
      membersSnapshot: matchedInvite?.membersSnapshot,
    })

    if (matchedInvite) {
      await clearPendingInvite(ctx, matchedInvite.token)
    }
  }
}

/** Import deployed backend multisig accounts into chrome.storage.local for this user. */
export async function syncLocalMultisigAccountsFromBackend(opts?: {
  activateFirstCreated?: boolean
}): Promise<{
  accounts: StoredAccount[]
  activeAccountId?: string
  created: StoredAccount[]
  updated: boolean
}> {
  const { accounts: localAccounts, activeAccountId } = await getAccounts()
  const passkeyCredentialIds = passkeyCredentialIdsFromAccounts(localAccounts)
  const pendingInvites = await getMultisigPendingInvites()
  const draftMeta = await getMultisigDraftMeta()
  const removedAddresses = new Set(await getRemovedAccountAddresses())

  const ctx: SyncContext = {
    localAccounts,
    activeAccountId,
    created: [],
    updated: false,
    pendingInvites,
    passkeyCredentialIds,
    removedAddresses,
  }

  // No local signer means nothing has proved who this user is (fresh install,
  // or every account removed). A leftover API `sid` cookie would otherwise
  // hand back the previous session user's wallets, so import nothing.
  if (localSignerAccounts(localAccounts).length === 0) {
    if (localAccounts.length === 0) {
      // Fresh install or every account removed: drop the cookie now rather than
      // letting the next request adopt the old session user's identity.
      await clearLatchApiSession().catch(() => undefined)
    }
    return {
      accounts: localAccounts,
      activeAccountId,
      created: [],
      updated: false,
    }
  }

  // Primary path: backend lists every deployed multisig for this session (owner + members).
  try {
    await importListedRemoteAccounts(ctx)
  } catch {
    // list may fail when session is missing or backend is unreachable
  }

  // Fallback: pending invites / creator draft meta for pre-deploy snapshots and repair.
  for (const invite of ctx.pendingInvites) {
    try {
      await syncFromPendingInvite(ctx, invite)
    } catch {
      // best-effort per invite
    }
  }

  if (draftMeta) {
    try {
      await syncFromCreatorDraftMeta(ctx, draftMeta)
    } catch {
      // best-effort
    }
  }

  if (opts?.activateFirstCreated && ctx.created[0]?.id) {
    await setActiveAccount(ctx.created[0].id)
    // `activeAccountId` is taken from storage on return; no need to mutate local const.
  }

  const latest = await getAccounts()
  return {
    accounts: latest.accounts,
    activeAccountId: latest.activeAccountId ?? activeAccountId,
    created: ctx.created,
    updated: ctx.updated,
  }
}
