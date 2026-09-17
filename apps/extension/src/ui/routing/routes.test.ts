import { describe, expect, it } from 'vitest'

import type { StoredAccount } from '@latch/types'

import {
  isOnboardingOnlyRoute,
  needsMnemonicUnlockFromAccounts,
  resolveMainRoute,
  routeKeepsUiMountedForWebauthn,
  SIGNER_ROUTES,
} from './routes'

function mnemonicAccount(id: string): StoredAccount {
  return {
    id,
    mode: 'mnemonic',
    smartAccountAddress: 'C' + 'A'.repeat(55),
    createdAt: 1,
  }
}

function passkeyAccount(id: string): StoredAccount {
  return {
    id,
    mode: 'passkey',
    smartAccountAddress: 'C' + 'B'.repeat(55),
    createdAt: 1,
  }
}

describe('routeKeepsUiMountedForWebauthn', () => {
  it('returns true for WebAuthn-sensitive routes', () => {
    expect(routeKeepsUiMountedForWebauthn('createPasskey')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('addAccountPasskey')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('send')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('swapConfirm')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('addMultisigOwners')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('joinMultisig')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('multisigProposalDetail')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('accountSigners')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('addBackupPasskey')).toBe(true)
    expect(routeKeepsUiMountedForWebauthn('fund')).toBe(true)
  })

  it('returns false for ordinary routes', () => {
    expect(routeKeepsUiMountedForWebauthn('home')).toBe(false)
    expect(routeKeepsUiMountedForWebauthn('swap')).toBe(false)
    expect(routeKeepsUiMountedForWebauthn('history')).toBe(false)
  })
})

describe('SIGNER_ROUTES', () => {
  it('covers the signer screens and keeps them all WebAuthn-safe', () => {
    expect(SIGNER_ROUTES).toEqual(['accountSigners', 'addBackupPasskey'])
    for (const route of SIGNER_ROUTES) {
      expect(routeKeepsUiMountedForWebauthn(route)).toBe(true)
    }
  })

  it('does not treat signer routes as onboarding-only', () => {
    for (const route of SIGNER_ROUTES) {
      expect(isOnboardingOnlyRoute(route)).toBe(false)
    }
  })
})

describe('resolveMainRoute', () => {
  it('forces unlockMnemonic when vault is locked', () => {
    expect(resolveMainRoute({ needsMnemonicUnlock: true, preferred: 'home' })).toBe(
      'unlockMnemonic'
    )
  })

  it('returns preferred route when unlocked', () => {
    expect(resolveMainRoute({ needsMnemonicUnlock: false, preferred: 'swap' })).toBe('swap')
  })

  it('defaults to home when unlocked and no preferred', () => {
    expect(resolveMainRoute({ needsMnemonicUnlock: false })).toBe('home')
  })
})

describe('needsMnemonicUnlockFromAccounts', () => {
  it('requires active mnemonic account with vault and unloaded signer', () => {
    const accounts = [mnemonicAccount('m1')]
    expect(needsMnemonicUnlockFromAccounts(accounts, 'm1', true, false)).toBe(true)
  })

  it('returns false when signer is already loaded', () => {
    const accounts = [mnemonicAccount('m1')]
    expect(needsMnemonicUnlockFromAccounts(accounts, 'm1', true, true)).toBe(false)
  })

  it('returns false for passkey accounts', () => {
    const accounts = [passkeyAccount('p1')]
    expect(needsMnemonicUnlockFromAccounts(accounts, 'p1', true, false)).toBe(false)
  })

  it('returns false when vault or active id is missing', () => {
    const accounts = [mnemonicAccount('m1')]
    expect(needsMnemonicUnlockFromAccounts(accounts, undefined, true, false)).toBe(false)
    expect(needsMnemonicUnlockFromAccounts(accounts, 'm1', false, false)).toBe(false)
    expect(needsMnemonicUnlockFromAccounts(accounts, 'm1', undefined, false)).toBe(false)
  })
})

describe('isOnboardingOnlyRoute', () => {
  it('identifies onboarding-only routes', () => {
    expect(isOnboardingOnlyRoute('welcome')).toBe(true)
    expect(isOnboardingOnlyRoute('chooseSigner')).toBe(true)
    expect(isOnboardingOnlyRoute('createPasskey')).toBe(true)
    expect(isOnboardingOnlyRoute('passkeyCreated')).toBe(true)
    expect(isOnboardingOnlyRoute('importSeed')).toBe(true)
    expect(isOnboardingOnlyRoute('importSeedEncrypt')).toBe(true)
  })

  it('returns false for main app routes', () => {
    expect(isOnboardingOnlyRoute('home')).toBe(false)
    expect(isOnboardingOnlyRoute('addAccount')).toBe(false)
  })
})
