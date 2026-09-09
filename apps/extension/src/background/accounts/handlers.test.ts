import { beforeEach, describe, expect, it, vi } from 'vitest'

const ensureSetupStateMatchesAccounts = vi.fn()
const getSetupState = vi.fn()
const setSetupState = vi.fn()
vi.mock('../actionBehavior', () => ({
  ensureSetupStateMatchesAccounts: (...a: unknown[]) => ensureSetupStateMatchesAccounts(...a),
  getSetupState: (...a: unknown[]) => getSetupState(...a),
  setSetupState: (...a: unknown[]) => setSetupState(...a),
}))

const clearLatchApiSession = vi.fn()
const passkeyAuthenticationFinish = vi.fn()
const getBackendAccounts = vi.fn()
vi.mock('../backend', () => ({
  clearLatchApiSession: (...a: unknown[]) => clearLatchApiSession(...a),
  createOrConnectPasskey: vi.fn(),
  ensureFreighterSmartAccountDeployed: vi.fn(),
  getBackendAccounts: (...a: unknown[]) => getBackendAccounts(...a),
  passkeyAuthenticationBegin: vi.fn(),
  passkeyAuthenticationFinish: (...a: unknown[]) => passkeyAuthenticationFinish(...a),
  passkeyRegistrationBegin: vi.fn(),
  passkeyRegistrationFinish: vi.fn(),
}))

const broadcastActiveAccountChanged = vi.fn()
vi.mock('../dappProviderEvents', () => ({
  broadcastActiveAccountChanged: (...a: unknown[]) => broadcastActiveAccountChanged(...a),
}))

const clearMnemonicSessionKeyForAccount = vi.fn()
const clearMnemonicSessionKeys = vi.fn()
vi.mock('../mnemonicSession', () => ({
  clearMnemonicSessionKeyForAccount: (...a: unknown[]) => clearMnemonicSessionKeyForAccount(...a),
  clearMnemonicSessionKeys: (...a: unknown[]) => clearMnemonicSessionKeys(...a),
  getMnemonicKeypair: vi.fn(),
  registerMnemonicKeypair: vi.fn(),
}))

vi.mock('../mnemonicVault', () => ({
  decryptMnemonicFromVault: vi.fn(),
  encryptMnemonicForVault: vi.fn(),
  loadMnemonicVaultRecord: vi.fn(),
  saveMnemonicVaultRecord: vi.fn(),
}))

vi.mock('../stellarMnemonic', () => ({ deriveStellarKeypairFromMnemonic: vi.fn() }))

const createAccount = vi.fn()
const deleteAccount = vi.fn()
const clearSession = vi.fn()
const getAccounts = vi.fn()
const removeRemovedAccountAddress = vi.fn()
vi.mock('../storage', () => ({
  createAccount: (...a: unknown[]) => createAccount(...a),
  deleteAccount: (...a: unknown[]) => deleteAccount(...a),
  clearSession: (...a: unknown[]) => clearSession(...a),
  getAccounts: (...a: unknown[]) => getAccounts(...a),
  removeRemovedAccountAddress: (...a: unknown[]) => removeRemovedAccountAddress(...a),
  renameAccount: vi.fn(),
  setActiveAccount: vi.fn(),
}))

import { tryHandleAccountsMessage } from './handlers'

const ok = <T>(data?: T) => ({ ok: true as const, data })

describe('tryHandleAccountsMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAccounts.mockResolvedValue({ accounts: [], activeAccountId: undefined })
    createAccount.mockImplementation(async (params: Record<string, unknown>) => ({
      account: { id: 'acct-1', createdAt: 1, ...params },
      activeAccountId: 'acct-1',
    }))
  })

  describe('PASSKEY_AUTH_FINISH', () => {
    it('persists only the credential that completed the ceremony', async () => {
      passkeyAuthenticationFinish.mockResolvedValue({
        smartAccountAddress: 'CMINE',
        activeCredentialId: 'cred-mine',
        keyDataHex: 'aabb',
        // Every smart account on the API session user, including wallets from
        // other passkeys this login did not prove.
        accounts: [
          { smartAccountAddress: 'CMINE', credentialId: 'cred-mine' },
          { smartAccountAddress: 'CSTRANGER-1', credentialId: 'cred-other-1' },
          { smartAccountAddress: 'CSTRANGER-2', credentialId: 'cred-other-2' },
        ],
      })

      const sendResponse = vi.fn()
      const handled = await tryHandleAccountsMessage(
        { type: 'PASSKEY_AUTH_FINISH', payload: { response: {} } as never },
        sendResponse,
        ok
      )

      expect(handled).toBe(true)
      expect(createAccount).toHaveBeenCalledTimes(1)
      expect(createAccount).toHaveBeenCalledWith({
        mode: 'passkey',
        smartAccountAddress: 'CMINE',
        passkeyCredentialId: 'cred-mine',
        passkeyKeyDataHex: 'aabb',
      })
    })

    it('lifts a prior removal of the account the user just logged into', async () => {
      passkeyAuthenticationFinish.mockResolvedValue({
        smartAccountAddress: 'CMINE',
        activeCredentialId: 'cred-mine',
        keyDataHex: 'aabb',
        accounts: [],
      })

      await tryHandleAccountsMessage(
        { type: 'PASSKEY_AUTH_FINISH', payload: { response: {} } as never },
        vi.fn(),
        ok
      )

      expect(removeRemovedAccountAddress).toHaveBeenCalledWith('CMINE')
    })

    it('falls back to the first listed credential id when none is marked active', async () => {
      passkeyAuthenticationFinish.mockResolvedValue({
        smartAccountAddress: 'CMINE',
        keyDataHex: 'aabb',
        accounts: [{ smartAccountAddress: 'CMINE', credentialId: 'cred-first' }],
      })

      await tryHandleAccountsMessage(
        { type: 'PASSKEY_AUTH_FINISH', payload: { response: {} } as never },
        vi.fn(),
        ok
      )

      expect(createAccount).toHaveBeenCalledTimes(1)
      expect(createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ passkeyCredentialId: 'cred-first' })
      )
    })

    it('throws when the API returns no credential id at all', async () => {
      passkeyAuthenticationFinish.mockResolvedValue({
        smartAccountAddress: 'CMINE',
        accounts: [],
      })

      await expect(
        tryHandleAccountsMessage(
          { type: 'PASSKEY_AUTH_FINISH', payload: { response: {} } as never },
          vi.fn(),
          ok
        )
      ).rejects.toThrow(/did not return a credential id/i)
      expect(createAccount).not.toHaveBeenCalled()
    })
  })

  describe('LOGOUT', () => {
    it('clears the API session and wipes local accounts so the next call is a fresh install', async () => {
      const sendResponse = vi.fn()
      const handled = await tryHandleAccountsMessage(
        { type: 'LOGOUT', payload: undefined },
        sendResponse,
        ok
      )

      expect(handled).toBe(true)
      expect(clearLatchApiSession).toHaveBeenCalledTimes(1)
      expect(clearMnemonicSessionKeys).toHaveBeenCalledTimes(1)
      expect(clearSession).toHaveBeenCalledTimes(1)
      expect(ensureSetupStateMatchesAccounts).not.toHaveBeenCalled()
      expect(sendResponse).toHaveBeenCalledWith(ok())
    })
  })

  describe('GET_BACKEND_ACCOUNTS', () => {
    it('threads optional credentialId to getBackendAccounts', async () => {
      getBackendAccounts.mockResolvedValue({ accounts: [] })
      const sendResponse = vi.fn()
      const handled = await tryHandleAccountsMessage(
        { type: 'GET_BACKEND_ACCOUNTS', payload: { credentialId: 'cred-a' } },
        sendResponse,
        ok
      )
      expect(handled).toBe(true)
      expect(getBackendAccounts).toHaveBeenCalledWith({ credentialId: 'cred-a' })
      expect(sendResponse).toHaveBeenCalledWith(ok({ accounts: [] }))
    })
  })

  describe('DELETE_ACCOUNT', () => {
    it('keeps the API session when other accounts remain', async () => {
      deleteAccount.mockResolvedValue({
        accounts: [{ id: 'acct-2' }],
        activeAccountId: 'acct-2',
        removedLastAccount: false,
      })

      const sendResponse = vi.fn()
      const handled = await tryHandleAccountsMessage(
        { type: 'DELETE_ACCOUNT', payload: { accountId: 'acct-1' } },
        sendResponse,
        ok
      )

      expect(handled).toBe(true)
      expect(deleteAccount).toHaveBeenCalledWith('acct-1')
      expect(clearMnemonicSessionKeyForAccount).toHaveBeenCalledWith('acct-1')
      expect(clearLatchApiSession).not.toHaveBeenCalled()
      expect(broadcastActiveAccountChanged).toHaveBeenCalledTimes(1)
      expect(sendResponse).toHaveBeenCalledWith(
        ok({ accounts: [{ id: 'acct-2' }], activeAccountId: 'acct-2', removedLastAccount: false })
      )
    })

    it('clears the API session when the last account is removed', async () => {
      deleteAccount.mockResolvedValue({
        accounts: [],
        activeAccountId: undefined,
        removedLastAccount: true,
      })

      await tryHandleAccountsMessage(
        { type: 'DELETE_ACCOUNT', payload: { accountId: 'acct-1' } },
        vi.fn(),
        ok
      )

      expect(clearLatchApiSession).toHaveBeenCalledTimes(1)
    })
  })

  it('returns false for unrecognized message types', async () => {
    const sendResponse = vi.fn()
    const handled = await tryHandleAccountsMessage(
      { type: 'NOT_AN_ACCOUNTS_MESSAGE' as never, payload: undefined },
      sendResponse,
      ok
    )
    expect(handled).toBe(false)
    expect(sendResponse).not.toHaveBeenCalled()
  })
})
