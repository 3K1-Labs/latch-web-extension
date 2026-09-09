import { describe, expect, it } from 'vitest'

import type {
  MultisigAccount,
  MultisigDraftMember,
  MultisigPendingInvite,
  StoredAccount,
} from '@latch/types'

import {
  draftMembersToSigners,
  localSignerAccounts,
  matchPendingInviteForRemoteAccount,
  multisigLocalAccountNeedsUpdate,
  normalizeListMultisigAccountsResponse,
  predictAddress,
  remoteMultisigMatchesLocalSigner,
  resolveRemoteMemberId,
} from './syncHelpers'

const passkeyAccount = (over: Partial<StoredAccount> = {}): StoredAccount =>
  ({
    id: 'a1',
    mode: 'passkey',
    smartAccountAddress: 'C1',
    passkeyCredentialId: 'cred-1',
    passkeyKeyDataHex: 'abcd',
    createdAt: 1,
    ...over,
  }) as StoredAccount

describe('multisig syncHelpers', () => {
  it('normalizes list accounts response shapes', () => {
    const accounts: MultisigAccount[] = [{ smartAccountAddress: 'CABC' }]
    expect(normalizeListMultisigAccountsResponse({ accounts })).toEqual(accounts)
    expect(normalizeListMultisigAccountsResponse({ data: { accounts } })).toEqual(accounts)
    expect(normalizeListMultisigAccountsResponse(accounts)).toEqual(accounts)
  })

  it('maps draft members to signer init requests', () => {
    const members: MultisigDraftMember[] = [
      { id: 'm1', memberType: 'passkey', keyDataHex: 'abcd' },
      { id: 'm2', memberType: 'seed', gAddress: 'GXYZ' },
    ]
    expect(draftMembersToSigners(members)).toEqual([
      { type: 'webauthn', label: undefined, keyDataHex: 'abcd' },
      { type: 'delegated', label: undefined, gAddress: 'GXYZ' },
    ])
  })

  it('resolves remote member id from local passkey key data', () => {
    const localAccounts = [
      {
        id: 'a1',
        mode: 'passkey',
        smartAccountAddress: 'C1',
        passkeyKeyDataHex: 'ABCD',
        createdAt: 1,
      },
    ] as StoredAccount[]
    const remote: MultisigAccount = {
      smartAccountAddress: 'CMULTI',
      members: [{ id: 'member-1', memberType: 'passkey', keyDataHex: 'abcd' }],
    }
    expect(resolveRemoteMemberId(remote, localAccounts)).toBe('member-1')
  })

  it('prefers backend memberId on listed accounts', () => {
    const remote: MultisigAccount = {
      smartAccountAddress: 'CMULTI',
      memberId: 'session-member-id',
      members: [{ id: 'other-member', memberType: 'passkey', keyDataHex: 'abcd' }],
    }
    expect(resolveRemoteMemberId(remote, [])).toBe('session-member-id')
  })

  it('predictAddress falls back to cached invite address', () => {
    expect(predictAddress(null, null, 'CCACHED')).toBe('CCACHED')
  })

  it('matches pending invites to listed remote accounts', () => {
    const invites: MultisigPendingInvite[] = [
      {
        token: 'tok-1',
        joinedAt: 1,
        smartAccountAddress: 'CMULTI',
        multisigMemberId: 'member-1',
      },
    ]
    const remote: MultisigAccount = {
      smartAccountAddress: 'CMULTI',
      memberId: 'member-1',
    }
    expect(matchPendingInviteForRemoteAccount(remote, invites, new Set())?.token).toBe('tok-1')
  })

  it('detects when local multisig metadata needs refresh', () => {
    const existing = {
      id: 'm1',
      mode: 'multisig',
      smartAccountAddress: 'CMULTI',
      label: 'Old name',
      createdAt: 1,
    } as StoredAccount
    expect(
      multisigLocalAccountNeedsUpdate(existing, {
        label: 'Family vault',
        memberId: 'member-2',
        threshold: 2,
        backendAccountId: 'backend-1',
      })
    ).toBe(true)
  })

  describe('localSignerAccounts', () => {
    it('counts passkeys with credential data and seeds with a G-address', () => {
      const accounts = [
        passkeyAccount({ id: 'p1' }),
        { id: 's1', mode: 'mnemonic', smartAccountAddress: 'C2', gAddress: 'GABC', createdAt: 1 },
      ] as StoredAccount[]
      expect(localSignerAccounts(accounts).map((a) => a.id)).toEqual(['p1', 's1'])
    })

    it('excludes imported multisig rows and passkeys with no credential data', () => {
      const accounts = [
        { id: 'm1', mode: 'multisig', smartAccountAddress: 'CMULTI', createdAt: 1 },
        {
          id: 'p2',
          mode: 'passkey',
          smartAccountAddress: 'C3',
          passkeyCredentialId: '   ',
          createdAt: 1,
        },
      ] as StoredAccount[]
      expect(localSignerAccounts(accounts)).toEqual([])
    })
  })

  describe('remoteMultisigMatchesLocalSigner', () => {
    const remote: MultisigAccount = {
      smartAccountAddress: 'CMULTI',
      members: [
        { id: 'member-1', memberType: 'passkey', credentialId: 'cred-1' },
        { id: 'member-2', memberType: 'seed', gAddress: 'GOTHER' },
      ],
    }

    it('matches on a local passkey credential id', () => {
      expect(remoteMultisigMatchesLocalSigner(remote, [passkeyAccount()])).toBe(true)
    })

    it('matches on a local seed G-address', () => {
      const seed = [
        { id: 's1', mode: 'mnemonic', smartAccountAddress: 'C9', gAddress: 'GOTHER', createdAt: 1 },
      ] as StoredAccount[]
      expect(remoteMultisigMatchesLocalSigner(remote, seed)).toBe(true)
    })

    it('matches on key data hex regardless of case', () => {
      const byKeyData: MultisigAccount = {
        smartAccountAddress: 'CMULTI',
        members: [{ id: 'member-1', memberType: 'passkey', keyDataHex: 'ABCD' }],
      }
      expect(
        remoteMultisigMatchesLocalSigner(byKeyData, [
          passkeyAccount({ passkeyCredentialId: undefined }),
        ])
      ).toBe(true)
    })

    it('rejects a wallet whose members do not include any local signer', () => {
      expect(
        remoteMultisigMatchesLocalSigner(remote, [
          passkeyAccount({ passkeyCredentialId: 'someone-else', passkeyKeyDataHex: 'ffff' }),
        ])
      ).toBe(false)
    })

    it('rejects creator-only rows that carry no member list', () => {
      const creatorOnly: MultisigAccount = { smartAccountAddress: 'CMULTI' }
      expect(remoteMultisigMatchesLocalSigner(creatorOnly, [passkeyAccount()])).toBe(false)
    })

    it('rejects everything when this install holds no signer', () => {
      expect(remoteMultisigMatchesLocalSigner(remote, [])).toBe(false)
      const multisigOnly = [
        { id: 'm1', mode: 'multisig', smartAccountAddress: 'CMULTI', createdAt: 1 },
      ] as StoredAccount[]
      expect(remoteMultisigMatchesLocalSigner(remote, multisigOnly)).toBe(false)
    })
  })
})
