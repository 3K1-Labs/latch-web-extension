import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StoredAccount } from '@latch/types'

const listMultisigAccounts = vi.fn()
vi.mock('../backend', () => ({
  listMultisigAccounts: (...args: unknown[]) => listMultisigAccounts(...args),
}))

const fetchDefaultContextRule = vi.fn()
vi.mock('./onchainSigners', () => ({
  fetchDefaultContextRule: (...args: unknown[]) => fetchDefaultContextRule(...args),
}))

const getAccounts = vi.fn()
const createMultisigAccount = vi.fn()
const removeRemovedAccountAddress = vi.fn()
const setActiveAccount = vi.fn()
vi.mock('../storage', () => ({
  getAccounts: (...args: unknown[]) => getAccounts(...args),
  createMultisigAccount: (...args: unknown[]) => createMultisigAccount(...args),
  removeRemovedAccountAddress: (...args: unknown[]) => removeRemovedAccountAddress(...args),
  setActiveAccount: (...args: unknown[]) => setActiveAccount(...args),
}))

vi.mock('../network/config', () => ({
  sorobanRpcUrlFromEnv: () => 'https://soroban-testnet.stellar.org',
  networkPassphraseFromEnv: () => 'Test SDF Network ; September 2015',
}))

import { addExistingMultisigAccount, chainSignersIncludeLocalSigner } from './addExistingAccount'

/** Valid contract strkey used as the wallet under test. */
const WALLET = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

const localPasskey: StoredAccount = {
  id: 'p1',
  mode: 'passkey',
  smartAccountAddress: 'CB3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGBXD',
  passkeyCredentialId: 'cred-1',
  passkeyKeyDataHex: 'aabbcc',
  createdAt: 1,
} as StoredAccount

describe('chainSignersIncludeLocalSigner', () => {
  it('matches a local passkey key data hex in the signer set', () => {
    expect(
      chainSignersIncludeLocalSigner(
        [
          { kind: 'external', keyDataHex: 'ffffff' },
          { kind: 'external', keyDataHex: 'AABBCC' },
        ],
        [localPasskey]
      )
    ).toBe(true)
  })

  it('matches a delegated signer against a local seed G-address', () => {
    const seed = {
      id: 's1',
      mode: 'mnemonic',
      smartAccountAddress: 'CSEED',
      gAddress: 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH',
      createdAt: 1,
    } as StoredAccount
    expect(
      chainSignersIncludeLocalSigner(
        [
          {
            kind: 'delegated',
            address: 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH',
          },
        ],
        [seed]
      )
    ).toBe(true)
  })

  it('matches a seed account by its raw ed25519 public key', () => {
    const seed = {
      id: 's1',
      mode: 'mnemonic',
      smartAccountAddress: 'CSEED',
      gAddress: 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH',
      createdAt: 1,
    } as StoredAccount
    // Same key material the G-address encodes, as raw hex.
    const ed25519Hex = '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29'
    expect(
      chainSignersIncludeLocalSigner([{ kind: 'external', keyDataHex: ed25519Hex }], [seed])
    ).toBe(true)
  })

  it('rejects a signer set that holds none of this install keys', () => {
    expect(
      chainSignersIncludeLocalSigner([{ kind: 'external', keyDataHex: 'ffffff' }], [localPasskey])
    ).toBe(false)
  })

  it('rejects when this install has no signer accounts', () => {
    expect(chainSignersIncludeLocalSigner([{ kind: 'external', keyDataHex: 'aabbcc' }], [])).toBe(
      false
    )
  })
})

describe('addExistingMultisigAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAccounts.mockResolvedValue({ accounts: [localPasskey], activeAccountId: 'p1' })
    createMultisigAccount.mockImplementation(async (params: { smartAccountAddress: string }) => ({
      account: { id: 'new-multisig', mode: 'multisig', ...params },
      activeAccountId: 'p1',
    }))
    listMultisigAccounts.mockResolvedValue({ accounts: [] })
  })

  it('rejects an address that is not a contract strkey', async () => {
    await expect(
      addExistingMultisigAccount({ smartAccountAddress: 'not-an-address' })
    ).rejects.toThrow(/valid MultiSig wallet address/i)
    expect(createMultisigAccount).not.toHaveBeenCalled()
  })

  it('rejects a wallet already in the local list', async () => {
    getAccounts.mockResolvedValue({
      accounts: [{ ...localPasskey, smartAccountAddress: WALLET }],
      activeAccountId: 'p1',
    })
    await expect(addExistingMultisigAccount({ smartAccountAddress: WALLET })).rejects.toThrow(
      /already in your accounts/i
    )
    expect(createMultisigAccount).not.toHaveBeenCalled()
  })

  it('rejects when this install holds no signer to check against', async () => {
    getAccounts.mockResolvedValue({ accounts: [], activeAccountId: undefined })
    await expect(addExistingMultisigAccount({ smartAccountAddress: WALLET })).rejects.toThrow(
      /Set up or sign in/i
    )
    expect(fetchDefaultContextRule).not.toHaveBeenCalled()
    expect(createMultisigAccount).not.toHaveBeenCalled()
  })

  it('adds without an on-chain read when the backend lists a matching member', async () => {
    listMultisigAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'backend-1',
          smartAccountAddress: WALLET,
          threshold: 2,
          label: 'Family vault',
          members: [{ id: 'member-1', memberType: 'passkey', credentialId: 'cred-1' }],
        },
      ],
    })

    const result = await addExistingMultisigAccount({ smartAccountAddress: WALLET })

    expect(result.verifiedVia).toBe('backend')
    expect(fetchDefaultContextRule).not.toHaveBeenCalled()
    expect(createMultisigAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        smartAccountAddress: WALLET,
        label: 'Family vault',
        multisigThreshold: 2,
        multisigMemberId: 'member-1',
        multisigBackendAccountId: 'backend-1',
      })
    )
    expect(removeRemovedAccountAddress).toHaveBeenCalledWith(WALLET)
  })

  it('ignores a listed wallet whose members do not match, then verifies on-chain', async () => {
    listMultisigAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'backend-1',
          smartAccountAddress: WALLET,
          members: [{ id: 'member-9', memberType: 'passkey', credentialId: 'someone-else' }],
        },
      ],
    })
    fetchDefaultContextRule.mockResolvedValue({
      ruleId: 1,
      signers: [
        { kind: 'external', keyDataHex: 'aabbcc' },
        { kind: 'external', keyDataHex: 'ddeeff' },
      ],
    })

    const result = await addExistingMultisigAccount({ smartAccountAddress: WALLET })

    expect(result.verifiedVia).toBe('onchain')
    expect(fetchDefaultContextRule).toHaveBeenCalled()
  })

  it('rejects a non-member: on-chain signers exclude this install', async () => {
    fetchDefaultContextRule.mockResolvedValue({
      ruleId: 1,
      signers: [
        { kind: 'external', keyDataHex: '111111' },
        { kind: 'external', keyDataHex: '222222' },
      ],
    })

    await expect(addExistingMultisigAccount({ smartAccountAddress: WALLET })).rejects.toThrow(
      /isn't a signer/i
    )
    expect(createMultisigAccount).not.toHaveBeenCalled()
    expect(removeRemovedAccountAddress).not.toHaveBeenCalled()
  })

  it('rejects a single-signer account', async () => {
    fetchDefaultContextRule.mockResolvedValue({
      ruleId: 1,
      signers: [{ kind: 'external', keyDataHex: 'aabbcc' }],
    })

    await expect(addExistingMultisigAccount({ smartAccountAddress: WALLET })).rejects.toThrow(
      /single-signer account/i
    )
    expect(createMultisigAccount).not.toHaveBeenCalled()
  })

  it('fails closed when the wallet cannot be read on-chain', async () => {
    fetchDefaultContextRule.mockRejectedValue(new Error('rpc down'))

    await expect(addExistingMultisigAccount({ smartAccountAddress: WALLET })).rejects.toThrow(
      /couldn't read that wallet on-chain/i
    )
    expect(createMultisigAccount).not.toHaveBeenCalled()
  })

  it('falls back to the on-chain read when the backend list call fails', async () => {
    listMultisigAccounts.mockRejectedValue(new Error('no session'))
    fetchDefaultContextRule.mockResolvedValue({
      ruleId: 1,
      signers: [
        { kind: 'external', keyDataHex: 'aabbcc' },
        { kind: 'external', keyDataHex: 'ddeeff' },
      ],
    })

    const result = await addExistingMultisigAccount({
      smartAccountAddress: WALLET,
      label: 'Shared',
    })

    expect(result.verifiedVia).toBe('onchain')
    expect(createMultisigAccount).toHaveBeenCalledWith(
      expect.objectContaining({ smartAccountAddress: WALLET, label: 'Shared' })
    )
  })
})
