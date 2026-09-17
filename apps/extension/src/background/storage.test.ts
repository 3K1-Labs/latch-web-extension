import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearDappPermissions,
  clearDappOriginDisconnected,
  clearSession,
  confirmPasskeySeq,
  createAccount,
  deleteAccount,
  deleteAccountSignerRecord,
  getAccounts,
  getAccountSignerRecords,
  getAccountsForNetwork,
  getDappPermissions,
  getRemovedAccountAddresses,
  getSetupStateForNetwork,
  isDappOriginDisconnected,
  markDappOriginDisconnected,
  peekNextPasskeySeq,
  removeRemovedAccountAddress,
  resetAccountsPartitionMigrationForTests,
  setDappPermissions,
  upsertAccountSignerRecord,
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

  it('repoints the existing wallet when a backup passkey logs in, instead of adding a row', async () => {
    await createAccount({
      mode: 'passkey',
      smartAccountAddress: 'CSHARED',
      passkeyCredentialId: 'cred-a',
      passkeyKeyDataHex: 'aa',
    })

    // Restoring with the backup passkey: same smart account, different
    // credential. Two rows here would show the user a duplicate wallet.
    await createAccount({
      mode: 'passkey',
      smartAccountAddress: 'CSHARED',
      passkeyCredentialId: 'cred-b',
      passkeyKeyDataHex: 'bb',
    })

    const { accounts } = await getAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.smartAccountAddress).toBe('CSHARED')
    expect(accounts[0]!.passkeyCredentialId).toBe('cred-b')
    expect(accounts[0]!.passkeyKeyDataHex).toBe('bb')
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
        smartAccountAddress: 'CSINGLE',
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

  describe('account signer records', () => {
    const backupSigner = {
      credentialId: 'cred-b',
      keyDataHex: 'bb',
      label: 'Backup (Latch 2) · backup',
      role: 'backup' as const,
      status: 'pending' as const,
      addedAt: 10,
    }

    it('round-trips a record for one account', async () => {
      await upsertAccountSignerRecord('CWALLET', backupSigner)
      expect(await getAccountSignerRecords('CWALLET')).toEqual([backupSigner])
      expect(await getAccountSignerRecords('COTHER')).toEqual([])
    })

    it('merges by credential id instead of appending a duplicate', async () => {
      await upsertAccountSignerRecord('CWALLET', backupSigner)
      await upsertAccountSignerRecord('CWALLET', {
        ...backupSigner,
        status: 'onchain',
        signerId: 7,
      })

      const records = await getAccountSignerRecords('CWALLET')
      expect(records).toHaveLength(1)
      expect(records[0]!.status).toBe('onchain')
      expect(records[0]!.signerId).toBe(7)
      expect(records[0]!.label).toBe(backupSigner.label)
    })

    it('clears pendingConfirm when the confirm succeeds', async () => {
      await upsertAccountSignerRecord('CWALLET', {
        ...backupSigner,
        pendingConfirm: { txHash: 'hash-1', contextRuleId: 3 },
      })
      await upsertAccountSignerRecord('CWALLET', {
        ...backupSigner,
        status: 'onchain',
        pendingConfirm: undefined,
      })

      expect((await getAccountSignerRecords('CWALLET'))[0]!.pendingConfirm).toBeUndefined()
    })

    it('partitions records per network', async () => {
      await upsertAccountSignerRecord('CWALLET', backupSigner)
      await setActiveNetwork('mainnet')
      expect(await getAccountSignerRecords('CWALLET')).toEqual([])

      await setActiveNetwork('testnet')
      expect(await getAccountSignerRecords('CWALLET')).toHaveLength(1)
    })

    it('deletes one record and leaves the others', async () => {
      await upsertAccountSignerRecord('CWALLET', backupSigner)
      await upsertAccountSignerRecord('CWALLET', { ...backupSigner, credentialId: 'cred-c' })

      await deleteAccountSignerRecord('CWALLET', 'cred-b')
      const records = await getAccountSignerRecords('CWALLET')
      expect(records.map((r) => r.credentialId)).toEqual(['cred-c'])
    })

    it('is wiped by clearSession, since logout is a full local wipe', async () => {
      await upsertAccountSignerRecord('CWALLET', backupSigner)

      await clearSession()

      expect(await getAccountSignerRecords('CWALLET')).toEqual([])
    })
  })

  describe('dapp permissions', () => {
    it('clearDappPermissions revokes one origin and leaves the others connected', async () => {
      await setDappPermissions('https://a.example', ['getPublicKey'])
      await setDappPermissions('https://b.example', ['getPublicKey'])

      await clearDappPermissions('https://a.example')

      expect(await getDappPermissions('https://a.example')).toEqual([])
      expect(await getDappPermissions('https://b.example')).toEqual(['getPublicKey'])
    })

    it('drops the origin key entirely, so a connected-sites list has no empty rows', async () => {
      await setDappPermissions('https://a.example', ['getPublicKey'])

      await clearDappPermissions('https://a.example')

      const stored = await chrome.storage.local.get(['latch.dappPermissions'])
      expect(stored['latch.dappPermissions']).toEqual({})
    })

    it('is idempotent for an origin that was never connected', async () => {
      await expect(clearDappPermissions('https://never.example')).resolves.toBeUndefined()
      expect(await getDappPermissions('https://never.example')).toEqual([])
    })

    it('is wiped wholesale by clearSession, since logout is a full local wipe', async () => {
      await setDappPermissions('https://a.example', ['getPublicKey'])
      await setDappPermissions('https://b.example', ['getPublicKey'])

      await clearSession()

      expect(await getDappPermissions('https://a.example')).toEqual([])
      expect(await getDappPermissions('https://b.example')).toEqual([])
    })
  })

  describe('dapp disconnected origins', () => {
    it('mark / is / clear round-trip', async () => {
      expect(await isDappOriginDisconnected('https://a.example')).toBe(false)
      await markDappOriginDisconnected('https://a.example')
      expect(await isDappOriginDisconnected('https://a.example')).toBe(true)
      await clearDappOriginDisconnected('https://a.example')
      expect(await isDappOriginDisconnected('https://a.example')).toBe(false)
    })

    it('setDappPermissions clears the sticky disconnect flag', async () => {
      await markDappOriginDisconnected('https://a.example')
      await setDappPermissions('https://a.example', ['getPublicKey'])
      expect(await isDappOriginDisconnected('https://a.example')).toBe(false)
    })

    it('is wiped by clearSession', async () => {
      await markDappOriginDisconnected('https://a.example')
      await clearSession()
      expect(await isDappOriginDisconnected('https://a.example')).toBe(false)
    })
  })

  describe('passkey sequence counter', () => {
    it('starts at 1 on a fresh install', async () => {
      expect(await peekNextPasskeySeq()).toBe(1)
    })

    it('peeking does not advance the counter', async () => {
      expect(await peekNextPasskeySeq()).toBe(1)
      expect(await peekNextPasskeySeq()).toBe(1)
      expect(await peekNextPasskeySeq()).toBe(1)
    })

    it('advances only once a passkey is confirmed', async () => {
      await confirmPasskeySeq(await peekNextPasskeySeq())
      expect(await peekNextPasskeySeq()).toBe(2)
      await confirmPasskeySeq(2)
      expect(await peekNextPasskeySeq()).toBe(3)
    })

    it('is monotonic under out-of-order or repeated commits', async () => {
      await confirmPasskeySeq(5)
      await confirmPasskeySeq(2)
      await confirmPasskeySeq(5)
      expect(await peekNextPasskeySeq()).toBe(6)
    })

    it('ignores nonsense commits', async () => {
      await confirmPasskeySeq(0)
      await confirmPasskeySeq(-3)
      await confirmPasskeySeq(Number.NaN)
      expect(await peekNextPasskeySeq()).toBe(1)
    })

    it('seeds past passkeys created before the counter existed, across networks', async () => {
      await createAccount({
        mode: 'passkey',
        smartAccountAddress: 'CTESTNET1',
        passkeyCredentialId: 'cred-t1',
        passkeyKeyDataHex: 'aa',
      })
      await createAccount({ mode: 'multisig', smartAccountAddress: 'CTESTNETMULTI' })
      await setActiveNetwork('mainnet')
      await createAccount({
        mode: 'passkey',
        smartAccountAddress: 'CMAINNET1',
        passkeyCredentialId: 'cred-m1',
        passkeyKeyDataHex: 'bb',
      })

      // Two passkeys already named "Latch account 1" and "Latch account 2".
      expect(await peekNextPasskeySeq()).toBe(3)
    })

    it('survives clearSession: LOGOUT cannot delete passkeys from the provider', async () => {
      await confirmPasskeySeq(4)

      await clearSession()

      expect(await peekNextPasskeySeq()).toBe(5)
    })
  })
})
