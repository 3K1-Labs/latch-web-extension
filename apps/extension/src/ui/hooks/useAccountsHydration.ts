import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import type {
  GetAccountsResponse,
  GetSetupStateResponse,
  SetSetupStateRequest,
  StoredAccount,
} from '@latch/types'

import { sendToBackground } from '../lib/backgroundClient'
import { apiSyncLocalMultisigAccounts } from '../lib/multisigFlow'
import { openOnboardingTab } from '../onboarding/openOnboardingTab'
import { storedAccountLabel } from '../lib/storedAccountLabel'
import {
  isOnboardingOnlyRoute,
  needsMnemonicUnlockFromAccounts,
  resolveMainRoute,
  ROUTES_GATED_BY_MNEMONIC_UNLOCK,
  type Route,
} from '../routing/routes'

export function useAccountsHydration({
  route,
  setRoute,
}: {
  route: Route
  setRoute: Dispatch<SetStateAction<Route>>
}) {
  const [setupState, setSetupState] = useState<GetSetupStateResponse['setupState']>('new')
  const [accountsHydrated, setAccountsHydrated] = useState(false)
  /** True only after GET_ACCOUNTS returned successfully (empty or not). False on timeout/error — never treat that as "needs setup". */
  const [accountsLoadSucceeded, setAccountsLoadSucceeded] = useState(false)
  const onboardingTabOpenedRef = useRef(false)
  const [accounts, setAccounts] = useState<StoredAccount[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | undefined>(undefined)
  const [activeNetwork, setActiveNetwork] = useState<'testnet' | 'mainnet'>('testnet')
  const [networkLabel, setNetworkLabel] = useState('Stellar Testnet')

  const activeAccount = useMemo(
    () => accounts.find((a) => a.id === activeAccountId) ?? accounts[0],
    [accounts, activeAccountId]
  )

  const activeAccountLabel = useMemo(() => {
    if (!activeAccount) return 'Account'
    const i = accounts.findIndex((x) => x.id === activeAccount.id)
    return storedAccountLabel(activeAccount, i >= 0 ? i : 0)
  }, [accounts, activeAccount])

  const [activeAccountHasMnemonicVault, setActiveAccountHasMnemonicVault] = useState(false)
  const [activeAccountMnemonicSignerLoaded, setActiveAccountMnemonicSignerLoaded] = useState(false)

  const needsMnemonicUnlock = useMemo(
    () =>
      activeAccount?.mode === 'mnemonic' &&
      activeAccountHasMnemonicVault &&
      !activeAccountMnemonicSignerLoaded,
    [activeAccount, activeAccountHasMnemonicVault, activeAccountMnemonicSignerLoaded]
  )

  useEffect(() => {
    void sendToBackground<undefined, GetSetupStateResponse>({
      type: 'GET_SETUP_STATE',
      payload: undefined,
    })
      .then((res) => {
        if (res.ok && res.data) setSetupState(res.data.setupState)
      })
      .catch(() => {})

    let cancelled = false
    void (async () => {
      // Load accounts first so we never flash "Set up Latch" while the SW is still waking.
      // Network is independent and can fill in after.
      try {
        const res = await sendToBackground<undefined, GetAccountsResponse>({
          type: 'GET_ACCOUNTS',
          payload: undefined,
        })
        if (cancelled) return
        if (!res.ok || !res.data) {
          setAccountsLoadSucceeded(false)
          return
        }
        setAccounts(res.data.accounts)
        setActiveAccountId(res.data.activeAccountId)
        setActiveAccountHasMnemonicVault(Boolean(res.data.activeAccountHasMnemonicVault))
        setActiveAccountMnemonicSignerLoaded(Boolean(res.data.activeAccountMnemonicSignerLoaded))
        setAccountsLoadSucceeded(true)
        if (res.data.accounts.length > 0) {
          const locked = needsMnemonicUnlockFromAccounts(
            res.data.accounts,
            res.data.activeAccountId,
            res.data.activeAccountHasMnemonicVault,
            res.data.activeAccountMnemonicSignerLoaded
          )
          setRoute((prev) =>
            prev === 'joinMultisig'
              ? prev
              : isOnboardingOnlyRoute(prev)
                ? resolveMainRoute({ needsMnemonicUnlock: locked })
                : resolveMainRoute({
                    needsMnemonicUnlock: locked,
                    preferred: ROUTES_GATED_BY_MNEMONIC_UNLOCK.includes(prev) ? prev : prev,
                  })
          )
        }
      } catch {
        if (!cancelled) setAccountsLoadSucceeded(false)
      } finally {
        if (!cancelled) setAccountsHydrated(true)
      }

      try {
        const netRes = await sendToBackground<
          undefined,
          { network: 'testnet' | 'mainnet'; networkLabel: string }
        >({
          type: 'GET_ACTIVE_NETWORK',
          payload: undefined,
        })
        if (cancelled) return
        if (netRes.ok && netRes.data?.network) {
          setActiveNetwork(netRes.data.network)
          setNetworkLabel(
            netRes.data.networkLabel ||
              (netRes.data.network === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet')
          )
        }
      } catch {
        // keep defaults
      }
    })()

    // Safety: never leave the shell stuck if the background SW is unresponsive.
    // Do NOT mark accountsLoadSucceeded — that would falsely open "Set up Latch".
    const hydrateWatchdog = window.setTimeout(() => {
      setAccountsHydrated(true)
    }, 8_000)

    return () => {
      cancelled = true
      window.clearTimeout(hydrateWatchdog)
    }
  }, [])

  // Retry GET_ACCOUNTS when the first attempt failed / timed out (keep Latch loader, never "Set up Latch").
  useEffect(() => {
    if (!accountsHydrated || accountsLoadSucceeded || accounts.length > 0) return
    let cancelled = false
    const attempt = async () => {
      try {
        const res = await sendToBackground<undefined, GetAccountsResponse>({
          type: 'GET_ACCOUNTS',
          payload: undefined,
        })
        if (cancelled || !res.ok || !res.data) return
        setAccounts(res.data.accounts)
        setActiveAccountId(res.data.activeAccountId)
        setActiveAccountHasMnemonicVault(Boolean(res.data.activeAccountHasMnemonicVault))
        setActiveAccountMnemonicSignerLoaded(Boolean(res.data.activeAccountMnemonicSignerLoaded))
        setAccountsLoadSucceeded(true)
        if (res.data.accounts.length > 0) {
          const locked = needsMnemonicUnlockFromAccounts(
            res.data.accounts,
            res.data.activeAccountId,
            res.data.activeAccountHasMnemonicVault,
            res.data.activeAccountMnemonicSignerLoaded
          )
          setRoute((prev) =>
            prev === 'joinMultisig'
              ? prev
              : resolveMainRoute({ needsMnemonicUnlock: locked, preferred: prev })
          )
        }
      } catch {
        // keep retrying
      }
    }
    void attempt()
    const t = window.setInterval(() => void attempt(), 2_500)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [accountsHydrated, accountsLoadSucceeded, accounts.length])

  useEffect(() => {
    if (!accountsHydrated) return

    if (accounts.length > 0) {
      onboardingTabOpenedRef.current = false
      setRoute((prev) => {
        if (prev === 'joinMultisig') return prev
        if (isOnboardingOnlyRoute(prev)) {
          return resolveMainRoute({ needsMnemonicUnlock })
        }
        return prev
      })
      return
    }

    // Only open setup when we *know* there are no accounts — not on SW timeout/error.
    if (!accountsLoadSucceeded) return
    if (route === 'joinMultisig') return

    if (!onboardingTabOpenedRef.current) {
      onboardingTabOpenedRef.current = true
      void openOnboardingTab().catch(() => {})
    }
  }, [accountsHydrated, accountsLoadSucceeded, accounts.length, needsMnemonicUnlock, route])

  async function persistSetupHasAccount(publicKey: string) {
    const req: SetSetupStateRequest = { setupState: 'has_account', accountPublicKey: publicKey }
    await sendToBackground<SetSetupStateRequest, unknown>({ type: 'SET_SETUP_STATE', payload: req })
    setSetupState('has_account')
  }

  async function refreshAccounts(): Promise<
    { accounts: StoredAccount[]; needsMnemonicUnlock: boolean } | undefined
  > {
    const res = await sendToBackground<undefined, GetAccountsResponse>({
      type: 'GET_ACCOUNTS',
      payload: undefined,
    })
    if (!res.ok || !res.data) return undefined
    return applyAccountsSnapshot({
      accounts: res.data.accounts,
      activeAccountId: res.data.activeAccountId,
      activeAccountHasMnemonicVault: res.data.activeAccountHasMnemonicVault,
      activeAccountMnemonicSignerLoaded: res.data.activeAccountMnemonicSignerLoaded,
    })
  }

  /** Apply a known accounts list without a second GET (e.g. after DELETE_ACCOUNT / LOGOUT). */
  function applyAccountsSnapshot(snapshot: {
    accounts: StoredAccount[]
    activeAccountId?: string
    activeAccountHasMnemonicVault?: boolean
    activeAccountMnemonicSignerLoaded?: boolean
  }): { accounts: StoredAccount[]; needsMnemonicUnlock: boolean } {
    setAccounts(snapshot.accounts)
    setActiveAccountId(snapshot.activeAccountId)
    setActiveAccountHasMnemonicVault(Boolean(snapshot.activeAccountHasMnemonicVault))
    setActiveAccountMnemonicSignerLoaded(Boolean(snapshot.activeAccountMnemonicSignerLoaded))
    setAccountsLoadSucceeded(true)
    setAccountsHydrated(true)
    if (snapshot.accounts.length === 0) {
      setSetupState('new')
    }
    const locked = needsMnemonicUnlockFromAccounts(
      snapshot.accounts,
      snapshot.activeAccountId,
      snapshot.activeAccountHasMnemonicVault,
      snapshot.activeAccountMnemonicSignerLoaded
    )
    return { accounts: snapshot.accounts, needsMnemonicUnlock: locked }
  }

  const syncMultisigAccounts = useCallback(async () => {
    try {
      const res = await apiSyncLocalMultisigAccounts()
      if (res.created.length > 0 || res.updated) await refreshAccounts()
    } catch {
      // best-effort
    }
  }, [])

  useEffect(() => {
    if (!accountsHydrated) return
    void syncMultisigAccounts()
  }, [accountsHydrated, route, syncMultisigAccounts])

  return {
    setupState,
    setSetupState,
    accountsHydrated,
    accountsLoadSucceeded,
    onboardingTabOpenedRef,
    accounts,
    activeAccountId,
    setActiveAccountId,
    activeNetwork,
    setActiveNetwork,
    networkLabel,
    setNetworkLabel,
    activeAccount,
    activeAccountLabel,
    activeAccountHasMnemonicVault,
    activeAccountMnemonicSignerLoaded,
    needsMnemonicUnlock,
    persistSetupHasAccount,
    refreshAccounts,
    applyAccountsSnapshot,
    syncMultisigAccounts,
  }
}
