import { describe, expect, it, beforeEach } from 'vitest'
import {
  createAccount,
  deleteAccount,
  getAccounts,
  getAccountsForNetwork,
  getRemovedAccountAddresses,
  getSetupStateForNetwork,
  removeRemovedAccountAddress,
  resetAccountsPartitionMigrationForTests,
} from './storage'
import { setActiveNetwork, setCachedActiveNetwork } from './network/config'

describe('background/storage', () => {
  beforeEach(() => {
    resetAccountsPartitionMigrationForTests()
    setCachedActiveNetwork('testnet')
  })

  it('createAccount persists account and sets activeAccountId on first insert', async () => {
    await createAccount({
      mode: 'passkey' as any,
      smartAccountAddress: 'GSMARTACCOUNT',
      passkeyCredentialId: 'cred',
      passkeyKeyDataHex: 'deadbeef',
    })

    const { accounts, activeAccountId } = await getAccounts()
    expect(accounts).toHaveLength(1)
    expect(activeAccountId).toBe(accounts[0]!.id)
    expect(accounts[0]!.mode).toBe('passkey')
    expect(accounts[0]!.smartAccountAddress).toBe('GSMARTACCOUNT')
  })

  it('migrates flat latch.accounts into testnet bucket and isolates mainnet', async () => {
    resetAccountsPartitionMigrationForTests()
    await chrome.storage.local.remove([
      'latch.accounts',
      'latch.activeAccountId',
      'latch.accounts.byNetwork',
      'latch.activeAccountId.byNetwork',
      'latch.network',
      'latch.setupState',
      'latch.setupState.byNetwork',
    ])
    setCachedActiveNetwork('testnet')
    await chrome.storage.local.set({
      'latch.accounts': [
        {
          id: 'legacy-1',
          mode: 'passkey',
          smartAccountAddress: 'CTEST',
          createdAt: 1,
        },
      ],
      'latch.activeAccountId': 'legacy-1',
    })

    const testnet = await getAccounts()
    expect(testnet.accounts).toHaveLength(1)
    expect(testnet.accounts[0]!.smartAccountAddress).toBe('CTEST')

    await setActiveNetwork('mainnet')
    const mainnet = await getAccounts()
    expect(mainnet.accounts).toHaveLength(0)

    await createAccount({
      mode: 'passkey' as any,
      smartAccountAddress: 'CMAIN',
      passkeyCredentialId: 'cred-m',
      passkeyKeyDataHex: 'aabb',
    })
    expect((await getAccounts()).accounts).toHaveLength(1)
    expect((await getAccountsForNetwork('testnet')).accounts).toHaveLength(1)
    expect((await getAccountsForNetwork('mainnet')).accounts[0]!.smartAccountAddress).toBe('CMAIN')

    await setActiveNetwork('testnet')
    expect((await getAccounts()).accounts[0]!.smartAccountAddress).toBe('CTEST')
  })

  it('createAccount does not replace an existing passkey C-address without replaceSmartAccountAddress', async () => {
    await createAccount({
      mode: 'passkey',
      smartAccountAddress: 'COLDADDRESS',
      passkeyCredentialId: 'cred-1',
      passkeyKeyDataHex: 'aa',
    })
    await createAccount({
      mode: 'passkey',
      smartAccountAddress: 'CNEWFACTORY',
      passkeyCredentialId: 'cred-1',
      passkeyKeyDataHex: 'aa',
    })
    const { accounts } = await getAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.smartAccountAddress).toBe('COLDADDRESS')

    const { patchAccountSmartAccountAddress } = await import('./storage')
    await patchAccountSmartAccountAddress({
      network: 'testnet',
      accountId: accounts[0]!.id,
      smartAccountAddress: 'CREPAIRED',
    })
    const after = await getAccounts()
    expect(after.accounts[0]!.smartAccountAddress).toBe('CREPAIRED')
  })

  describe('deleteAccount', () => {
    it('removes the row, moves active to a survivor, and denylists the address', async () => {
      await createAccount({
        mode: 'passkey',
        smartAccountAddress: 'CFIRST',
        passkeyCredentialId: 'cred-1',
        passkeyKeyDataHex: 'aa',
      })
      await createAccount({
        mode: 'passkey',
        smartAccountAddress: 'CSECOND',
        passkeyCredentialId: 'cred-2',
        passkeyKeyDataHex: 'bb',
      })

      const before = await getAccounts()
      const first = before.accounts.find((a) => a.smartAccountAddress === 'CFIRST')!
      expect(before.activeAccountId).toBe(first.id)

      const result = await deleteAccount(first.id)

      expect(result.removedLastAccount).toBe(false)
      expect(result.accounts).toHaveLength(1)
      expect(result.accounts[0]!.smartAccountAddress).toBe('CSECOND')
      expect(result.activeAccountId).toBe(result.accounts[0]!.id)
      expect(await getRemovedAccountAddresses()).toContain('CFIRST')

      const after = await getAccounts()
      expect(after.accounts.map((a) => a.smartAccountAddress)).toEqual(['CSECOND'])
    })

    it('reports removedLastAccount and resets setup state when the list empties', async () => {
      await createAccount({
        mode: 'passkey',
        smartAccountAddress: 'CONLY',
        passkeyCredentialId: 'cred-only',
        passkeyKeyDataHex: 'cc',
      })
      const { accounts } = await getAccounts()

      const result = await deleteAccount(accounts[0]!.id)

      expect(result.removedLastAccount).toBe(true)
      expect(result.accounts).toHaveLength(0)
      expect(result.activeAccountId).toBeUndefined()
      expect(await getSetupStateForNetwork('testnet')).toBe('new')
    })

    it('is a no-op for an unknown account id', async () => {
      await createAccount({
        mode: 'passkey',
        smartAccountAddress: 'CKEEP',
        passkeyCredentialId: 'cred-keep',
        passkeyKeyDataHex: 'dd',
      })

      const result = await deleteAccount('does-not-exist')

      expect(result.removedLastAccount).toBe(false)
      expect(result.accounts).toHaveLength(1)
      expect(await getRemovedAccountAddresses()).toHaveLength(0)
    })

    it('denylist is per network', async () => {
      await createAccount({
        mode: 'passkey',
        smartAccountAddress: 'CTESTNET',
        passkeyCredentialId: 'cred-t',
        passkeyKeyDataHex: 'ee',
      })
      const { accounts } = await getAccounts()
      await deleteAccount(accounts[0]!.id)
      expect(await getRemovedAccountAddresses()).toContain('CTESTNET')

      await setActiveNetwork('mainnet')
      expect(await getRemovedAccountAddresses()).toHaveLength(0)
    })

    it('removeRemovedAccountAddress clears the denylist entry for an explicit re-add', async () => {
      await createAccount({
        mode: 'multisig',
        smartAccountAddress: 'CMULTI',
      })
      const { accounts } = await getAccounts()
      await deleteAccount(accounts[0]!.id)
      expect(await getRemovedAccountAddresses()).toContain('CMULTI')

      await removeRemovedAccountAddress('CMULTI')
      expect(await getRemovedAccountAddresses()).toHaveLength(0)
    })
  })
})
