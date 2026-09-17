import type {
  AccountMode,
  AccountSignerRecord,
  DappPermission,
  GetAccountsResponse,
  MultisigDraftMeta,
  MultisigPendingInvite,
  Network,
  PendingDappRequest,
  StoredAccount,
} from '@latch/types'

import { clearAllMnemonicVaultRecords, removeMnemonicVaultForAccount } from './mnemonicVault'
import { getActiveNetwork } from './network/config'

const STORAGE_KEYS = {
  /** Legacy flat setup; migrated into setupStateByNetwork.testnet */
  setupState: 'latch.setupState',
  setupStateByNetwork: 'latch.setupState.byNetwork',
  legacyAccountPublicKey: 'latch.accountPublicKey',
  /** Legacy flat accounts; migrated into accountsByNetwork.testnet */
  accounts: 'latch.accounts',
  accountsByNetwork: 'latch.accounts.byNetwork',
  /** Legacy flat active id; migrated into activeAccountIdByNetwork.testnet */
  activeAccountId: 'latch.activeAccountId',
  activeAccountIdByNetwork: 'latch.activeAccountId.byNetwork',
  dappPermissions: 'latch.dappPermissions',
  /**
   * Origins that called `disconnect()` and must not auto-open Grant Access
   * until a fresh page load (or an explicit permission grant) clears them.
   */
  dappDisconnectedOrigins: 'latch.dappDisconnectedOrigins',
  pendingDappRequests: 'latch.pendingDappRequests',
  multisigPendingInvites: 'latch.multisigPendingInvites',
  multisigDraftMeta: 'latch.multisigDraftMeta',
  multisigProposalsBannerDismissed: 'latch.multisigProposalsBannerDismissed',
  /**
   * Smart account addresses the user removed from this install, per network.
   * The Latch API lists accounts by session cookie, so without this a removed
   * wallet would be re-imported by the next multisig sync.
   */
  removedAccounts: 'latch.removedAccounts.byNetwork',
  /**
   * Backup passkey signers this install attached, keyed by smart account
   * address per network. The API has no per-account signer list, so this is
   * the only record of which credentials sign for a wallet — including ones
   * that are authorized on-chain but still waiting on a confirm retry.
   */
  accountSigners: 'latch.accountSigners.byNetwork',
  /**
   * Highest passkey sequence number this install has ever used for a WebAuthn
   * `user.name` / `user.displayName` ("Latch Wallet 3"). Deliberately NOT part
   * of clearSession(): logging out drops local accounts but cannot delete the
   * passkeys from iCloud Keychain / Google Password Manager, so a reused number
   * would put two identically named credentials in the user's picker.
   */
  passkeySeq: 'latch.passkeySeq',
} as const

type DappPermissionsStore = Record<string, DappPermission[] | undefined>

type AccountsByNetwork = Partial<Record<Network, StoredAccount[]>>
type ActiveIdByNetwork = Partial<Record<Network, string | undefined>>
type SetupStateByNetwork = Partial<Record<Network, string | undefined>>
type RemovedAccountsByNetwork = Partial<Record<Network, string[]>>
/** smart account address → the signers this install knows about. */
type AccountSignersByAddress = Record<string, AccountSignerRecord[] | undefined>
type AccountSignersByNetwork = Partial<Record<Network, AccountSignersByAddress>>

export function storageKeys() {
  return STORAGE_KEYS
}

let accountsMigratePromise: Promise<void> | null = null

/**
 * One-time: move flat latch.accounts / activeAccountId into the testnet bucket.
 * Idempotent; safe to call on every getAccounts().
 */
async function ensureAccountsPartitionMigrated(): Promise<void> {
  if (accountsMigratePromise) return accountsMigratePromise
  accountsMigratePromise = (async () => {
    const res = await chrome.storage.local.get([
      STORAGE_KEYS.accounts,
      STORAGE_KEYS.activeAccountId,
      STORAGE_KEYS.accountsByNetwork,
      STORAGE_KEYS.activeAccountIdByNetwork,
      STORAGE_KEYS.setupState,
      STORAGE_KEYS.setupStateByNetwork,
    ])

    const byNetwork = (res[STORAGE_KEYS.accountsByNetwork] as AccountsByNetwork | undefined) ?? {}
    const activeByNetwork =
      (res[STORAGE_KEYS.activeAccountIdByNetwork] as ActiveIdByNetwork | undefined) ?? {}
    const setupByNetwork =
      (res[STORAGE_KEYS.setupStateByNetwork] as SetupStateByNetwork | undefined) ?? {}

    const flatAccounts = res[STORAGE_KEYS.accounts] as StoredAccount[] | undefined
    const flatActive = res[STORAGE_KEYS.activeAccountId] as string | undefined
    const flatSetup = res[STORAGE_KEYS.setupState] as string | undefined

    const patch: Record<string, unknown> = {}
    const remove: string[] = []

    const hasPartitioned = Array.isArray(byNetwork.testnet) || Array.isArray(byNetwork.mainnet)

    if (!hasPartitioned && Array.isArray(flatAccounts) && flatAccounts.length > 0) {
      patch[STORAGE_KEYS.accountsByNetwork] = {
        ...byNetwork,
        testnet: flatAccounts,
      }
      if (flatActive) {
        patch[STORAGE_KEYS.activeAccountIdByNetwork] = {
          ...activeByNetwork,
          testnet: flatActive,
        }
      }
      remove.push(STORAGE_KEYS.accounts, STORAGE_KEYS.activeAccountId)
    } else if (!hasPartitioned && !Array.isArray(byNetwork.testnet)) {
      // Ensure empty buckets exist so later writes use partitioned keys.
      patch[STORAGE_KEYS.accountsByNetwork] = {
        testnet: byNetwork.testnet ?? [],
        mainnet: byNetwork.mainnet ?? [],
      }
      if (Object.keys(activeByNetwork).length === 0) {
        patch[STORAGE_KEYS.activeAccountIdByNetwork] = { testnet: undefined, mainnet: undefined }
      }
      if (Array.isArray(flatAccounts)) {
        remove.push(STORAGE_KEYS.accounts)
      }
      if (flatActive !== undefined) {
        remove.push(STORAGE_KEYS.activeAccountId)
      }
    }

    if (setupByNetwork.testnet === undefined && setupByNetwork.mainnet === undefined && flatSetup) {
      patch[STORAGE_KEYS.setupStateByNetwork] = {
        ...setupByNetwork,
        testnet: flatSetup,
      }
      remove.push(STORAGE_KEYS.setupState)
    }

    if (Object.keys(patch).length > 0) {
      await chrome.storage.local.set(patch)
    }
    if (remove.length > 0) {
      await chrome.storage.local.remove(remove)
    }
  })().finally(() => {
    // Allow retry if migration threw; otherwise keep promise for dedupe within session.
  })

  try {
    await accountsMigratePromise
  } catch (err) {
    accountsMigratePromise = null
    throw err
  }
}

async function readAccountsBucket(network: Network): Promise<{
  accounts: StoredAccount[]
  activeAccountId?: string
}> {
  await ensureAccountsPartitionMigrated()
  const res = await chrome.storage.local.get([
    STORAGE_KEYS.accountsByNetwork,
    STORAGE_KEYS.activeAccountIdByNetwork,
  ])
  const byNetwork = (res[STORAGE_KEYS.accountsByNetwork] as AccountsByNetwork | undefined) ?? {}
  const activeByNetwork =
    (res[STORAGE_KEYS.activeAccountIdByNetwork] as ActiveIdByNetwork | undefined) ?? {}
  return {
    accounts: byNetwork[network] ?? [],
    activeAccountId: activeByNetwork[network],
  }
}

async function writeAccountsBucket(
  network: Network,
  accounts: StoredAccount[],
  activeAccountId: string | undefined
): Promise<void> {
  await ensureAccountsPartitionMigrated()
  const res = await chrome.storage.local.get([
    STORAGE_KEYS.accountsByNetwork,
    STORAGE_KEYS.activeAccountIdByNetwork,
  ])
  const byNetwork = (res[STORAGE_KEYS.accountsByNetwork] as AccountsByNetwork | undefined) ?? {}
  const activeByNetwork =
    (res[STORAGE_KEYS.activeAccountIdByNetwork] as ActiveIdByNetwork | undefined) ?? {}

  await chrome.storage.local.set({
    [STORAGE_KEYS.accountsByNetwork]: { ...byNetwork, [network]: accounts },
    [STORAGE_KEYS.activeAccountIdByNetwork]: {
      ...activeByNetwork,
      [network]: activeAccountId,
    },
  })
}

export async function getAccountsForNetwork(network: Network): Promise<GetAccountsResponse> {
  return await readAccountsBucket(network)
}

export async function getAccounts(): Promise<GetAccountsResponse> {
  const network = await getActiveNetwork()
  return await readAccountsBucket(network)
}

export async function setActiveAccount(accountId: string): Promise<void> {
  const network = await getActiveNetwork()
  const { accounts } = await readAccountsBucket(network)
  await writeAccountsBucket(network, accounts, accountId)
}

function newId() {
  return crypto.randomUUID()
}

export async function upsertAccount(
  input: Omit<StoredAccount, 'id' | 'createdAt'> & Partial<Pick<StoredAccount, 'id' | 'createdAt'>>
) {
  const network = await getActiveNetwork()
  const { accounts, activeAccountId } = await readAccountsBucket(network)

  const now = Date.now()
  const id = input.id ?? newId()
  const createdAt = input.createdAt ?? now

  const next: StoredAccount = { ...input, id, createdAt }
  const existingIdx = accounts.findIndex((a) => a.id === id)
  const nextAccounts =
    existingIdx >= 0 ? accounts.map((a, i) => (i === existingIdx ? next : a)) : [...accounts, next]

  const nextActive = activeAccountId ?? id
  await writeAccountsBucket(network, nextAccounts, nextActive)

  return { account: next, activeAccountId: nextActive }
}

/** Directly rewrite a stored account's C-address in a specific network bucket. */
export async function patchAccountSmartAccountAddress(args: {
  network: Network
  accountId: string
  smartAccountAddress: string
}): Promise<StoredAccount | null> {
  const addr = args.smartAccountAddress.trim()
  if (!addr) return null
  const { accounts, activeAccountId } = await readAccountsBucket(args.network)
  const idx = accounts.findIndex((a) => a.id === args.accountId)
  if (idx < 0) return null
  const prev = accounts[idx]!
  if (prev.smartAccountAddress === addr) return prev
  const next: StoredAccount = { ...prev, smartAccountAddress: addr }
  const nextAccounts = accounts.map((a, i) => (i === idx ? next : a))
  await writeAccountsBucket(args.network, nextAccounts, activeAccountId)
  return next
}

export async function createAccount(params: {
  mode: AccountMode
  smartAccountAddress: string
  gAddress?: string
  passkeyCredentialId?: string
  passkeyKeyDataHex?: string
  label?: string
  multisigThreshold?: number
  multisigMemberId?: string
  multisigBackendAccountId?: string
  cosignWckRefId?: string
  cosignBlindSignerId?: string
  cosignLinkedAccountId?: string
  multisigAccountSaltHex?: string
  multisigMembersSnapshot?:
    | import('@latch/types').MultisigDraftMember[]
    | import('@latch/types').CosignMemberInit[]
  /**
   * When false/omitted, never replace an existing passkey account's C-address with a
   * different one (guards against create-or-connect factory drift). Repair flows set true.
   */
  replaceSmartAccountAddress?: boolean
}) {
  const { accounts } = await getAccounts()

  let existing: StoredAccount | undefined
  if (params.mode === 'passkey') {
    existing = accounts.find((a) => {
      if (a.mode !== 'passkey') return false
      if (params.passkeyCredentialId && a.passkeyCredentialId === params.passkeyCredentialId)
        return true
      if (params.smartAccountAddress && a.smartAccountAddress === params.smartAccountAddress)
        return true
      return false
    })
  } else if (params.mode === 'mnemonic') {
    existing = accounts.find((a) => {
      if (a.mode !== 'mnemonic') return false
      if (params.gAddress && a.gAddress === params.gAddress) return true
      if (params.smartAccountAddress && a.smartAccountAddress === params.smartAccountAddress)
        return true
      return false
    })
  } else if (params.mode === 'multisig') {
    existing = accounts.find(
      (a) =>
        a.mode === 'multisig' &&
        params.smartAccountAddress &&
        a.smartAccountAddress === params.smartAccountAddress
    )
  }

  // Resolve the passkey pointer as a consistent (credentialId, keyDataHex) pair.
  // `passkeyKeyDataHex` is `uncompressedPubkey || credentialIdBytes`, so the
  // credential id and key data MUST stay in sync. PASSKEY_AUTH_FINISH upserts
  // sibling accounts with only a `credentialId` (no keyDataHex); those must not
  // clobber an existing complete pair, otherwise later signing fails with
  // "Missing passkey data" even though a working passkey exists.
  let passkeyCredentialId = params.passkeyCredentialId ?? existing?.passkeyCredentialId
  let passkeyKeyDataHex = params.passkeyKeyDataHex ?? existing?.passkeyKeyDataHex
  if (params.mode === 'passkey') {
    const incomingHasFullPair = !!params.passkeyCredentialId && !!params.passkeyKeyDataHex
    const existingHasFullPair = !!existing?.passkeyCredentialId && !!existing?.passkeyKeyDataHex
    if (incomingHasFullPair) {
      // Authoritative, self-consistent pair from registration / active login.
      passkeyCredentialId = params.passkeyCredentialId
      passkeyKeyDataHex = params.passkeyKeyDataHex
    } else if (existingHasFullPair && existing) {
      // Keep the existing complete pair rather than overwriting the credential id
      // with one that has no matching key data (incomplete sibling payload).
      passkeyCredentialId = existing.passkeyCredentialId
      passkeyKeyDataHex = existing.passkeyKeyDataHex
    }
  }

  return await upsertAccount({
    id: existing?.id,
    createdAt: existing?.createdAt,
    mode: params.mode,
    smartAccountAddress: (() => {
      const incoming = params.smartAccountAddress?.trim() ?? ''
      const prev = existing?.smartAccountAddress?.trim() ?? ''
      if (
        params.mode === 'passkey' &&
        prev &&
        incoming &&
        prev !== incoming &&
        !params.replaceSmartAccountAddress
      ) {
        return prev
      }
      return params.smartAccountAddress
    })(),
    gAddress: params.gAddress,
    passkeyCredentialId,
    passkeyKeyDataHex,
    label: params.label ?? existing?.label,
    multisigThreshold: params.multisigThreshold ?? existing?.multisigThreshold,
    multisigMemberId: params.multisigMemberId ?? existing?.multisigMemberId,
    multisigBackendAccountId: params.multisigBackendAccountId ?? existing?.multisigBackendAccountId,
    cosignWckRefId: params.cosignWckRefId ?? existing?.cosignWckRefId,
    cosignBlindSignerId: params.cosignBlindSignerId ?? existing?.cosignBlindSignerId,
    cosignLinkedAccountId: params.cosignLinkedAccountId ?? existing?.cosignLinkedAccountId,
    multisigAccountSaltHex: params.multisigAccountSaltHex ?? existing?.multisigAccountSaltHex,
    multisigMembersSnapshot: params.multisigMembersSnapshot ?? existing?.multisigMembersSnapshot,
  })
}

export async function createMultisigAccount(params: {
  smartAccountAddress: string
  label?: string
  multisigThreshold?: number
  multisigMemberId?: string
  multisigBackendAccountId?: string
  cosignWckRefId?: string
  cosignBlindSignerId?: string
  cosignLinkedAccountId?: string
  multisigAccountSaltHex?: string
  multisigMembersSnapshot?:
    | import('@latch/types').MultisigDraftMember[]
    | import('@latch/types').CosignMemberInit[]
}) {
  return await createAccount({
    mode: 'multisig',
    ...params,
  })
}

export async function getMultisigPendingInvites(): Promise<MultisigPendingInvite[]> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.multisigPendingInvites])
  return (res[STORAGE_KEYS.multisigPendingInvites] as MultisigPendingInvite[] | undefined) ?? []
}

export async function addMultisigPendingInvite(
  invite: MultisigPendingInvite
): Promise<MultisigPendingInvite[]> {
  const current = await getMultisigPendingInvites()
  const filtered = current.filter((i) => i.token !== invite.token)
  const next = [...filtered, invite]
  await chrome.storage.local.set({ [STORAGE_KEYS.multisigPendingInvites]: next })
  return next
}

export async function upsertMultisigPendingInvite(
  token: string,
  patch: Partial<MultisigPendingInvite>
): Promise<MultisigPendingInvite[]> {
  const current = await getMultisigPendingInvites()
  const existing = current.find((i) => i.token === token)
  const invite: MultisigPendingInvite = {
    token,
    joinedAt: existing?.joinedAt ?? Date.now(),
    ...existing,
    ...patch,
  }
  return addMultisigPendingInvite(invite)
}

export async function removeMultisigPendingInvite(token: string): Promise<MultisigPendingInvite[]> {
  const current = await getMultisigPendingInvites()
  const next = current.filter((i) => i.token !== token)
  await chrome.storage.local.set({ [STORAGE_KEYS.multisigPendingInvites]: next })
  return next
}

export async function getMultisigDraftMeta(): Promise<MultisigDraftMeta | null> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.multisigDraftMeta])
  return (res[STORAGE_KEYS.multisigDraftMeta] as MultisigDraftMeta | undefined) ?? null
}

export async function setMultisigDraftMeta(meta: MultisigDraftMeta): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.multisigDraftMeta]: meta })
}

export async function clearMultisigDraftMeta(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEYS.multisigDraftMeta])
}

export async function getMultisigProposalsBannerDismissed(): Promise<string[]> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.multisigProposalsBannerDismissed])
  return (res[STORAGE_KEYS.multisigProposalsBannerDismissed] as string[] | undefined) ?? []
}

export async function dismissMultisigProposalsBanner(accountId: string): Promise<string[]> {
  const current = await getMultisigProposalsBannerDismissed()
  if (current.includes(accountId)) return current
  const next = [...current, accountId]
  await chrome.storage.local.set({ [STORAGE_KEYS.multisigProposalsBannerDismissed]: next })
  return next
}

/** Passkey accounts across every network bucket, for the one-time seq seed. */
async function countStoredPasskeyAccounts(): Promise<number> {
  await ensureAccountsPartitionMigrated()
  const res = await chrome.storage.local.get([STORAGE_KEYS.accountsByNetwork])
  const byNetwork = (res[STORAGE_KEYS.accountsByNetwork] as AccountsByNetwork | undefined) ?? {}
  return Object.values(byNetwork).reduce(
    (n, accounts) => n + (accounts ?? []).filter((a) => a.mode === 'passkey').length,
    0
  )
}

async function readPasskeySeq(): Promise<number> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.passkeySeq])
  const stored = res[STORAGE_KEYS.passkeySeq]
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) {
    return Math.floor(stored)
  }
  // An install that already created passkeys under the old account-count naming
  // starts above them, so the next name cannot land on a number the credential
  // manager is already showing.
  const seeded = await countStoredPasskeyAccounts()
  await chrome.storage.local.set({ [STORAGE_KEYS.passkeySeq]: seeded })
  return seeded
}

/**
 * Sequence number the next passkey should use. Deliberately does not advance
 * the counter: registration begin is prefetched on screen mount and re-run on
 * every retry, so incrementing here would burn a number every time a user
 * merely opens the create screen. Callers call confirmPasskeySeq() once the
 * passkey actually exists.
 */
export async function peekNextPasskeySeq(): Promise<number> {
  return (await readPasskeySeq()) + 1
}

/** Record that `seq` was used. Monotonic, so an out-of-order commit cannot rewind. */
export async function confirmPasskeySeq(seq: number): Promise<void> {
  if (!Number.isFinite(seq) || seq <= 0) return
  const current = await readPasskeySeq()
  const next = Math.max(current, Math.floor(seq))
  if (next === current) return
  await chrome.storage.local.set({ [STORAGE_KEYS.passkeySeq]: next })
}

async function readRemovedAccounts(network: Network): Promise<string[]> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.removedAccounts])
  const byNetwork =
    (res[STORAGE_KEYS.removedAccounts] as RemovedAccountsByNetwork | undefined) ?? {}
  return byNetwork[network] ?? []
}

async function writeRemovedAccounts(network: Network, addresses: string[]): Promise<void> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.removedAccounts])
  const byNetwork =
    (res[STORAGE_KEYS.removedAccounts] as RemovedAccountsByNetwork | undefined) ?? {}
  await chrome.storage.local.set({
    [STORAGE_KEYS.removedAccounts]: { ...byNetwork, [network]: addresses },
  })
}

/** Smart account addresses the user removed on this install (active network). */
export async function getRemovedAccountAddresses(): Promise<string[]> {
  return await readRemovedAccounts(await getActiveNetwork())
}

export async function addRemovedAccountAddress(smartAccountAddress: string): Promise<void> {
  const addr = smartAccountAddress.trim()
  if (!addr) return
  const network = await getActiveNetwork()
  const current = await readRemovedAccounts(network)
  if (current.includes(addr)) return
  await writeRemovedAccounts(network, [...current, addr])
}

/** Clear the denylist entry so an explicit re-add can succeed. */
export async function removeRemovedAccountAddress(smartAccountAddress: string): Promise<void> {
  const addr = smartAccountAddress.trim()
  if (!addr) return
  const network = await getActiveNetwork()
  const current = await readRemovedAccounts(network)
  if (!current.includes(addr)) return
  await writeRemovedAccounts(
    network,
    current.filter((a) => a !== addr)
  )
}

async function readAccountSignersMap(network: Network): Promise<AccountSignersByAddress> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.accountSigners])
  const byNetwork = (res[STORAGE_KEYS.accountSigners] as AccountSignersByNetwork | undefined) ?? {}
  return byNetwork[network] ?? {}
}

async function writeAccountSignersMap(
  network: Network,
  byAddress: AccountSignersByAddress
): Promise<void> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.accountSigners])
  const byNetwork = (res[STORAGE_KEYS.accountSigners] as AccountSignersByNetwork | undefined) ?? {}
  await chrome.storage.local.set({
    [STORAGE_KEYS.accountSigners]: { ...byNetwork, [network]: byAddress },
  })
}

/** Backup signers this install attached to `smartAccountAddress` (active network). */
export async function getAccountSignerRecords(
  smartAccountAddress: string
): Promise<AccountSignerRecord[]> {
  const addr = smartAccountAddress.trim()
  if (!addr) return []
  const byAddress = await readAccountSignersMap(await getActiveNetwork())
  return byAddress[addr] ?? []
}

/** Insert or merge one signer record, keyed by credential id. */
export async function upsertAccountSignerRecord(
  smartAccountAddress: string,
  record: AccountSignerRecord
): Promise<AccountSignerRecord[]> {
  const addr = smartAccountAddress.trim()
  const credentialId = record.credentialId.trim()
  if (!addr || !credentialId) return []
  const network = await getActiveNetwork()
  const byAddress = await readAccountSignersMap(network)
  const current = byAddress[addr] ?? []
  const existing = current.find((s) => s.credentialId === credentialId)
  const merged: AccountSignerRecord = { ...existing, ...record, credentialId }
  // `pendingConfirm` is only meaningful while the confirm call is outstanding;
  // an explicit undefined must clear it rather than fall back to the old hash.
  if (record.pendingConfirm === undefined) delete merged.pendingConfirm
  const next = existing
    ? current.map((s) => (s.credentialId === credentialId ? merged : s))
    : [...current, merged]
  await writeAccountSignersMap(network, { ...byAddress, [addr]: next })
  return next
}

export async function deleteAccountSignerRecord(
  smartAccountAddress: string,
  credentialId: string
): Promise<AccountSignerRecord[]> {
  const addr = smartAccountAddress.trim()
  const credId = credentialId.trim()
  if (!addr || !credId) return []
  const network = await getActiveNetwork()
  const byAddress = await readAccountSignersMap(network)
  const current = byAddress[addr] ?? []
  const next = current.filter((s) => s.credentialId !== credId)
  if (next.length === current.length) return current
  await writeAccountSignersMap(network, { ...byAddress, [addr]: next })
  return next
}

/**
 * Remove an account from this install only. The smart account still exists
 * on-chain and multisig signers are untouched; the user can add it back later.
 */
export async function deleteAccount(accountId: string): Promise<{
  accounts: StoredAccount[]
  activeAccountId?: string
  removedLastAccount: boolean
}> {
  const network = await getActiveNetwork()
  const { accounts, activeAccountId } = await readAccountsBucket(network)
  const target = accounts.find((a) => a.id === accountId)
  if (!target) {
    return { accounts, activeAccountId, removedLastAccount: false }
  }

  const nextAccounts = accounts.filter((a) => a.id !== accountId)
  const nextActive =
    activeAccountId === accountId ? nextAccounts[0]?.id : (activeAccountId ?? nextAccounts[0]?.id)

  await writeAccountsBucket(network, nextAccounts, nextActive)
  await removeMnemonicVaultForAccount(accountId)

  const addr = target.smartAccountAddress?.trim()
  if (addr && !nextAccounts.some((a) => a.smartAccountAddress?.trim() === addr)) {
    const current = await readRemovedAccounts(network)
    if (!current.includes(addr)) {
      await writeRemovedAccounts(network, [...current, addr])
    }
  }

  if (nextAccounts.length === 0) {
    const res = await chrome.storage.local.get([STORAGE_KEYS.setupStateByNetwork])
    const setupByNetwork =
      (res[STORAGE_KEYS.setupStateByNetwork] as SetupStateByNetwork | undefined) ?? {}
    await chrome.storage.local.set({
      [STORAGE_KEYS.setupStateByNetwork]: { ...setupByNetwork, [network]: 'new' },
    })
    await chrome.storage.local.remove([STORAGE_KEYS.legacyAccountPublicKey])
  }

  return {
    accounts: nextAccounts,
    activeAccountId: nextActive,
    removedLastAccount: nextAccounts.length === 0,
  }
}

export async function renameAccount(args: { accountId: string; label?: string }) {
  const network = await getActiveNetwork()
  const { accounts, activeAccountId } = await readAccountsBucket(network)
  const nextAccounts = accounts.map((a) =>
    a.id === args.accountId ? { ...a, label: args.label } : a
  )
  await writeAccountsBucket(network, nextAccounts, activeAccountId)
}

export async function getSetupStateForNetwork(network: Network): Promise<string | undefined> {
  await ensureAccountsPartitionMigrated()
  const res = await chrome.storage.local.get([
    STORAGE_KEYS.setupStateByNetwork,
    STORAGE_KEYS.setupState,
  ])
  const byNetwork = (res[STORAGE_KEYS.setupStateByNetwork] as SetupStateByNetwork | undefined) ?? {}
  if (byNetwork[network] !== undefined) return byNetwork[network]
  // Legacy flat key only applies to testnet.
  if (network === 'testnet') {
    return res[STORAGE_KEYS.setupState] as string | undefined
  }
  return undefined
}

export async function setSetupStateForNetwork(
  network: Network,
  setupState: string,
  accountPublicKey?: string
): Promise<void> {
  await ensureAccountsPartitionMigrated()
  const res = await chrome.storage.local.get([STORAGE_KEYS.setupStateByNetwork])
  const byNetwork = (res[STORAGE_KEYS.setupStateByNetwork] as SetupStateByNetwork | undefined) ?? {}
  const patch: Record<string, unknown> = {
    [STORAGE_KEYS.setupStateByNetwork]: { ...byNetwork, [network]: setupState },
  }
  if (accountPublicKey !== undefined) {
    patch[STORAGE_KEYS.legacyAccountPublicKey] = accountPublicKey
  }
  await chrome.storage.local.set(patch)
}

export async function getDappPermissions(origin: string): Promise<DappPermission[]> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.dappPermissions])
  const store = (res[STORAGE_KEYS.dappPermissions] as DappPermissionsStore | undefined) ?? {}
  return store[origin] ?? []
}

export async function setDappPermissions(
  origin: string,
  allowed: DappPermission[]
): Promise<DappPermission[]> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.dappPermissions])
  const store = (res[STORAGE_KEYS.dappPermissions] as DappPermissionsStore | undefined) ?? {}
  const next: DappPermissionsStore = { ...store, [origin]: allowed }
  await chrome.storage.local.set({ [STORAGE_KEYS.dappPermissions]: next })
  // A grant means the site is connected again — drop the sticky disconnect flag.
  await clearDappOriginDisconnected(origin)
  return allowed
}

async function readDisconnectedOrigins(): Promise<string[]> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.dappDisconnectedOrigins])
  const raw = res[STORAGE_KEYS.dappDisconnectedOrigins]
  return Array.isArray(raw) ? (raw as string[]) : []
}

/** After `disconnect()`, Grant Access stays closed until a fresh page session. */
export async function markDappOriginDisconnected(origin: string): Promise<void> {
  const current = await readDisconnectedOrigins()
  if (current.includes(origin)) return
  await chrome.storage.local.set({
    [STORAGE_KEYS.dappDisconnectedOrigins]: [...current, origin],
  })
}

export async function clearDappOriginDisconnected(origin: string): Promise<void> {
  const current = await readDisconnectedOrigins()
  if (!current.includes(origin)) return
  const next = current.filter((o) => o !== origin)
  if (next.length === 0) {
    await chrome.storage.local.remove([STORAGE_KEYS.dappDisconnectedOrigins])
    return
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.dappDisconnectedOrigins]: next })
}

export async function isDappOriginDisconnected(origin: string): Promise<boolean> {
  const current = await readDisconnectedOrigins()
  return current.includes(origin)
}

/** Revoke one origin's allowlist entry. Other origins are untouched. */
export async function clearDappPermissions(origin: string): Promise<void> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.dappPermissions])
  const store = (res[STORAGE_KEYS.dappPermissions] as DappPermissionsStore | undefined) ?? {}
  if (!(origin in store)) return
  const next: DappPermissionsStore = { ...store }
  // Drop the key entirely so a future connected-sites list has no empty rows.
  delete next[origin]
  await chrome.storage.local.set({ [STORAGE_KEYS.dappPermissions]: next })
}

export async function listPendingDappRequests(): Promise<PendingDappRequest[]> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.pendingDappRequests])
  return (res[STORAGE_KEYS.pendingDappRequests] as PendingDappRequest[] | undefined) ?? []
}

export async function addPendingDappRequest(req: PendingDappRequest) {
  const current = await listPendingDappRequests()
  await chrome.storage.local.set({ [STORAGE_KEYS.pendingDappRequests]: [...current, req] })
}

export async function removePendingDappRequest(requestId: string) {
  const current = await listPendingDappRequests()
  await chrome.storage.local.set({
    [STORAGE_KEYS.pendingDappRequests]: current.filter((r) => r.id !== requestId),
  })
}

/** Drop durable queue entries that cannot complete (e.g. SW restarted). */
export async function clearPendingDappRequests() {
  await chrome.storage.local.remove([STORAGE_KEYS.pendingDappRequests])
}

export async function clearSession() {
  await clearAllMnemonicVaultRecords()
  await chrome.storage.local.remove([
    STORAGE_KEYS.accounts,
    STORAGE_KEYS.activeAccountId,
    STORAGE_KEYS.accountsByNetwork,
    STORAGE_KEYS.activeAccountIdByNetwork,
    STORAGE_KEYS.setupState,
    STORAGE_KEYS.setupStateByNetwork,
    STORAGE_KEYS.legacyAccountPublicKey,
    STORAGE_KEYS.dappPermissions,
    STORAGE_KEYS.dappDisconnectedOrigins,
    STORAGE_KEYS.pendingDappRequests,
    STORAGE_KEYS.removedAccounts,
    STORAGE_KEYS.accountSigners,
  ])
}

/** Reset migration latch for tests. */
export function resetAccountsPartitionMigrationForTests(): void {
  accountsMigratePromise = null
}
