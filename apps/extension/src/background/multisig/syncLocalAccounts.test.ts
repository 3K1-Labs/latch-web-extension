import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StoredAccount } from '@latch/types'

const clearLatchApiSession = vi.fn()
const listMultisigAccounts = vi.fn()
vi.mock('../backend', () => ({
  clearLatchApiSession: (...a: unknown[]) => clearLatchApiSession(...a),
  listMultisigAccounts: (...a: unknown[]) => listMultisigAccounts(...a),
  getActiveMultisigDraft: vi.fn(),
  getMultisigDraft: vi.fn(),
  getMultisigDraftByInviteToken: vi.fn(),
  predictMultisigAccountFromSigners: vi.fn(),
  predictMultisigDraftAddress: vi.fn(),
  registerMultisigAccount: vi.fn(),
}))

const createMultisigAccount = vi.fn()
const getAccounts = vi.fn()
const getMultisigDraftMeta = vi.fn()
const getMultisigPendingInvites = vi.fn()
const getRemovedAccountAddresses = vi.fn()
vi.mock('../storage', () => ({
  createMultisigAccount: (...a: unknown[]) => createMultisigAccount(...a),
  getAccounts: (...a: unknown[]) => getAccounts(...a),
  getMultisigDraftMeta: (...a: unknown[]) => getMultisigDraftMeta(...a),
  getMultisigPendingInvites: (...a: unknown[]) => getMultisigPendingInvites(...a),
  getRemovedAccountAddresses: (...a: unknown[]) => getRemovedAccountAddresses(...a),
  removeMultisigPendingInvite: vi.fn(),
  setActiveAccount: vi.fn(),
  upsertMultisigPendingInvite: vi.fn(),
}))

import { syncLocalMultisigAccountsFromBackend } from './syncLocalAccounts'

const WALLET = 'CMULTIWALLET'

const localPasskey = {
  id: 'p1',
  mode: 'passkey',
  smartAccountAddress: 'CMINE',
  passkeyCredentialId: 'cred-mine',
  passkeyKeyDataHex: 'aabb',
  createdAt: 1,
} as StoredAccount

/** A wallet listed for the session where one member is this install's passkey. */
const remoteWithMyMember = {
  id: 'backend-1',
  smartAccountAddress: WALLET,
  threshold: 2,
  label: 'Family vault',
  members: [
    { id: 'member-1', memberType: 'passkey', credentialId: 'cred-mine' },
    { id: 'member-2', memberType: 'passkey', credentialId: 'cred-other' },
  ],
}

describe('syncLocalMultisigAccountsFromBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearLatchApiSession.mockResolvedValue(undefined)
    getMultisigPendingInvites.mockResolvedValue([])
    getMultisigDraftMeta.mockResolvedValue(null)
    getRemovedAccountAddresses.mockResolvedValue([])
    listMultisigAccounts.mockResolvedValue({ accounts: [] })
    createMultisigAccount.mockImplementation(async (params: Record<string, unknown>) => ({
      account: { id: 'multisig-1', mode: 'multisig', createdAt: 2, ...params },
      activeAccountId: 'p1',
    }))
  })

  it('imports nothing and clears the API session when local storage is empty', async () => {
    getAccounts.mockResolvedValue({ accounts: [], activeAccountId: undefined })

    const result = await syncLocalMultisigAccountsFromBackend()

    expect(listMultisigAccounts).not.toHaveBeenCalled()
    expect(createMultisigAccount).not.toHaveBeenCalled()
    expect(clearLatchApiSession).toHaveBeenCalledTimes(1)
    expect(result.created).toEqual([])
    expect(result.updated).toBe(false)
  })

  it('imports nothing when the only local rows are previously imported multisigs', async () => {
    const multisigOnly = [
      { id: 'm1', mode: 'multisig', smartAccountAddress: WALLET, createdAt: 1 },
    ] as StoredAccount[]
    getAccounts.mockResolvedValue({ accounts: multisigOnly, activeAccountId: 'm1' })

    await syncLocalMultisigAccountsFromBackend()

    expect(listMultisigAccounts).not.toHaveBeenCalled()
    expect(createMultisigAccount).not.toHaveBeenCalled()
    // Storage is not empty, so the session cookie is left alone.
    expect(clearLatchApiSession).not.toHaveBeenCalled()
  })

  it('imports a listed wallet whose member matches a local signer', async () => {
    getAccounts.mockResolvedValue({ accounts: [localPasskey], activeAccountId: 'p1' })
    listMultisigAccounts.mockResolvedValue({ accounts: [remoteWithMyMember] })

    await syncLocalMultisigAccountsFromBackend()

    expect(createMultisigAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        smartAccountAddress: WALLET,
        label: 'Family vault',
        multisigThreshold: 2,
        multisigMemberId: 'member-1',
      })
    )
  })

  it('skips a creator-only wallet with no matching member', async () => {
    getAccounts.mockResolvedValue({ accounts: [localPasskey], activeAccountId: 'p1' })
    listMultisigAccounts.mockResolvedValue({
      accounts: [
        { id: 'backend-2', smartAccountAddress: 'CCREATORONLY' },
        {
          id: 'backend-3',
          smartAccountAddress: 'CSOMEONEELSE',
          members: [{ id: 'member-9', memberType: 'passkey', credentialId: 'cred-other' }],
        },
      ],
    })

    await syncLocalMultisigAccountsFromBackend()

    expect(createMultisigAccount).not.toHaveBeenCalled()
  })

  it('does not resurrect a wallet the user removed on this install', async () => {
    getAccounts.mockResolvedValue({ accounts: [localPasskey], activeAccountId: 'p1' })
    listMultisigAccounts.mockResolvedValue({ accounts: [remoteWithMyMember] })
    getRemovedAccountAddresses.mockResolvedValue([WALLET])

    await syncLocalMultisigAccountsFromBackend()

    expect(createMultisigAccount).not.toHaveBeenCalled()
  })
})
