import type { StoredAccount } from '@latch/types'

export type Theme = 'dark' | 'light'
export type Surface = 'popup' | 'sidepanel'
export type UiSurfacePreference = 'popup' | 'sidepanel'
export type Page = 'main' | 'settings'

export type Route =
  | 'welcome'
  | 'chooseSigner'
  | 'createPasskey'
  | 'passkeyCreated'
  | 'addAccount'
  | 'addAccountPasskey'
  | 'createMultisig'
  | 'addMultisigOwners'
  | 'multisigThreshold'
  | 'multisigReviewDeploy'
  | 'multisigSuccess'
  | 'addExistingMultisig'
  | 'joinMultisig'
  | 'multisigProposals'
  | 'multisigProposalDetail'
  | 'multisigWallets'
  | 'importSeed'
  | 'importSeedEncrypt'
  | 'unlockMnemonic'
  | 'home'
  | 'explore'
  | 'history'
  | 'transactionDetail'
  | 'swap'
  | 'swapConfirm'
  | 'send'
  | 'receive'
  | 'fund'
  | 'dappApproval'
  | 'migration'
  | 'migrationSuccess'

/**
 * WebAuthn must run in the same document update as the user click as much as possible.
 * The global loading screen replaces route content and unmounts the button; Chrome (esp. side panel) then drops transient activation, so the passkey sheet never appears.
 */
export function routeKeepsUiMountedForWebauthn(route: Route): boolean {
  return (
    route === 'createPasskey' ||
    route === 'addAccountPasskey' ||
    route === 'send' ||
    route === 'swapConfirm' ||
    route === 'addMultisigOwners' ||
    route === 'joinMultisig' ||
    route === 'multisigProposalDetail' ||
    route === 'fund'
  )
}

export const ROUTES_GATED_BY_MNEMONIC_UNLOCK: Route[] = [
  'home',
  'explore',
  'history',
  'transactionDetail',
  'swap',
  'swapConfirm',
  'send',
  'receive',
  'fund',
  'migration',
  'migrationSuccess',
  'dappApproval',
]

export function resolveMainRoute(args: { needsMnemonicUnlock: boolean; preferred?: Route }): Route {
  if (args.needsMnemonicUnlock) return 'unlockMnemonic'
  return args.preferred ?? 'home'
}

export function needsMnemonicUnlockFromAccounts(
  accounts: StoredAccount[],
  activeAccountId: string | undefined,
  hasVault: boolean | undefined,
  signerLoaded: boolean | undefined
): boolean {
  if (!activeAccountId || !hasVault || signerLoaded !== false) return false
  const active = accounts.find((a) => a.id === activeAccountId)
  return active?.mode === 'mnemonic'
}

export const ONBOARDING_ONLY_ROUTES: Route[] = [
  'welcome',
  'chooseSigner',
  'createPasskey',
  'passkeyCreated',
  'importSeed',
  'importSeedEncrypt',
]

export function isOnboardingOnlyRoute(route: Route): boolean {
  return ONBOARDING_ONLY_ROUTES.includes(route)
}

export const MULTISIG_ROUTES: Route[] = [
  'createMultisig',
  'addMultisigOwners',
  'multisigThreshold',
  'multisigReviewDeploy',
  'multisigSuccess',
  'addExistingMultisig',
  'joinMultisig',
  'multisigProposals',
  'multisigProposalDetail',
  'multisigWallets',
]
