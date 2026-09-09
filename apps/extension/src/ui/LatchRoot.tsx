import '../style.css'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  DeleteAccountRequest,
  DeleteAccountResponse,
  GetSetupStateResponse,
  MultisigProposal,
  SetActiveAccountRequest,
} from '@latch/types'

import { HistoryScreen } from './screens/history/HistoryScreen'
import { HomeScreen } from './screens/HomeScreen'
import { TransactionDetailScreen } from './screens/transaction-detail/TransactionDetailScreen'
import { MigrationScreen } from './screens/MigrationScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import {
  MultisigRouteViews,
  multisigPendingApprovalCount,
  useMultisigJoinTokenOnMount,
} from './multisig/MultisigRouteViews'
import { parseMultisigJoinTokenFromLocation } from './lib/multisigDeepLink'
import { apiGetMultisigProposalsBannerDismissed } from './lib/multisigFlow'
import { ExploreScreen } from './screens/explore/ExploreScreen'
import { SwapCatalogLoadingOverlay } from './screens/swap/components/SwapCatalogLoadingOverlay'
import { SwapTransactionLoadingOverlay } from './screens/swap/components/SwapTransactionLoadingOverlay'
import { openOnboardingTab } from './onboarding/openOnboardingTab'
import { AccountMenu } from './components/AccountMenu'
import { HomeLoadingOverlay } from './screens/home/components/HomeLoadingOverlay'
import { MainBottomNav, type MainTab } from './screens/home/components/MainBottomNav'
import { storedAccountLabel } from './lib/storedAccountLabel'
import { FullScreenLoaderOverlay } from './components/FullScreenLoaderOverlay'
import { markMigrationHomePromoCompleted } from './lib/migrationHomePrefs'
import { RenameAccountDialog } from './components/RenameAccountDialog'
import { OpenSetupTabScreen } from './screens/setup/OpenSetupTabScreen'
import { MigrationSuccessScreen } from './screens/migration/MigrationSuccessScreen'
import { ReceiveFlow } from './screens/receive/ReceiveFlow'
import { FundScreen } from './screens/fund/FundScreen'
import { buildTransactionDetail } from './lib/historyFormat'
import type { TransactionDetailVm } from './types/transaction-detail'
import { friendlyError, sendToBackground } from './lib/backgroundClient'
import { closeWalletSurface, openSidePanel, setDefaultSurface } from './lib/uiSurface'
import {
  MULTISIG_ROUTES,
  ROUTES_GATED_BY_MNEMONIC_UNLOCK,
  resolveMainRoute,
  routeKeepsUiMountedForWebauthn,
  type Page,
  type Route,
  type Surface,
} from './routing/routes'
import { useTheme } from './hooks/useTheme'
import { useUiSurfacePreference } from './hooks/useUiSurfacePreference'
import { useAccountsHydration } from './hooks/useAccountsHydration'
import { usePortfolioAndHistory } from './hooks/usePortfolioAndHistory'
import { SwapRouteViews, type SwapOverlayFlags } from './swap/SwapRouteViews'
import { SendRouteViews } from './send/SendRouteViews'
import { AccountRouteViews } from './accounts/AccountRouteViews'
import { DappRouteViews } from './dapp/DappRouteViews'

export function LatchRoot({ surface }: { surface: Surface }) {
  useTheme()
  const { pref, setPref } = useUiSurfacePreference()

  const [route, setRoute] = useState<Route>(() =>
    parseMultisigJoinTokenFromLocation() ? 'joinMultisig' : 'home'
  )
  const [page, setPage] = useState<Page>('main')

  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const {
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
    needsMnemonicUnlock,
    persistSetupHasAccount,
    refreshAccounts,
    applyAccountsSnapshot,
  } = useAccountsHydration({ route, setRoute })

  const {
    portfolioRows,
    totalBalanceUsd,
    portfolioLoading,
    portfolioHydrated,
    portfolioError,
    historySections,
    historyLoading,
    historyError,
    recentActivityItems,
    loadHistory,
    loadPortfolio,
  } = usePortfolioAndHistory({
    accounts,
    activeAccountId,
    activeNetwork,
    route,
    page,
    needsMnemonicUnlock,
    setupState,
    accountsHydrated,
    accountsLoadSucceeded,
  })

  const [renameAccountId, setRenameAccountId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [multisigJoinToken, setMultisigJoinToken] = useState<string | null>(() =>
    parseMultisigJoinTokenFromLocation()
  )
  const [multisigDetailProposalId, setMultisigDetailProposalId] = useState<string | null>(null)
  const [multisigProposals, setMultisigProposals] = useState<MultisigProposal[]>([])
  const [, setMultisigBannerDismissedIds] = useState<string[]>([])

  const [unlockReturnRoute, setUnlockReturnRoute] = useState<'home' | 'migration' | null>(null)
  const [transactionDetail, setTransactionDetail] = useState<TransactionDetailVm | null>(null)
  const [transactionDetailReturnRoute, setTransactionDetailReturnRoute] = useState<Route>('history')

  const openSwapRef = useRef<() => void>(() => {})
  const openSendRef = useRef<() => void>(() => {})
  const clearDappPendingRef = useRef<() => void>(() => {})
  const [swapOverlayFlags, setSwapOverlayFlags] = useState<SwapOverlayFlags>({
    catalogLoading: false,
    payCatalogEmpty: true,
    swapBusy: false,
    swapStep: 'confirm',
  })

  useEffect(() => {
    if (!needsMnemonicUnlock) return
    if (page === 'settings') setPage('main')
    if (ROUTES_GATED_BY_MNEMONIC_UNLOCK.includes(route)) {
      setRoute('unlockMnemonic')
    }
  }, [needsMnemonicUnlock, route, page])

  useEffect(() => {
    if (route !== 'migrationSuccess' || !activeAccount?.id) return
    void markMigrationHomePromoCompleted(activeAccount.id)
  }, [route, activeAccount?.id])

  useEffect(() => {
    void apiGetMultisigProposalsBannerDismissed()
      .then(setMultisigBannerDismissedIds)
      .catch(() => {})
  }, [])

  const loadMultisigProposals = useCallback(async () => {
    if (!activeAccount?.smartAccountAddress || activeAccount.mode !== 'multisig') {
      setMultisigProposals([])
      return
    }
    try {
      const res = await sendToBackground<
        { smartAccountAddress: string },
        { proposals: MultisigProposal[] }
      >({
        type: 'MULTISIG_LIST_PROPOSALS',
        payload: { smartAccountAddress: activeAccount.smartAccountAddress },
      })
      if (res.ok && res.data?.proposals) setMultisigProposals(res.data.proposals)
      else setMultisigProposals([])
    } catch {
      // ignore — home banner is optional
    }
  }, [activeAccount])

  useEffect(() => {
    if (route !== 'home' || activeAccount?.mode !== 'multisig') return
    void loadMultisigProposals()
  }, [route, activeAccount?.id, activeAccount?.mode, loadMultisigProposals])

  const multisigPendingCount = useMemo(
    () => multisigPendingApprovalCount(multisigProposals, activeAccount?.multisigMemberId),
    [multisigProposals, activeAccount?.multisigMemberId]
  )

  const hasPendingMultisigProposals = multisigPendingCount > 0

  function openSwapFromNav() {
    if (activeAccount?.mode === 'multisig') return
    openSwapRef.current()
  }

  function openSendFlow() {
    openSendRef.current()
  }

  function handleMainTabSelect(tab: MainTab) {
    if (tab === 'home') setRoute('home')
    else if (tab === 'swap') openSwapFromNav()
    else if (tab === 'history') setRoute('history')
    else if (tab === 'explore') setRoute('explore')
  }

  const showOnboardingTabPrompt =
    accountsHydrated &&
    accountsLoadSucceeded &&
    accounts.length === 0 &&
    route !== 'joinMultisig' &&
    !loading

  /** Open full-tab onboarding, then dismiss this popup/side panel so the stub setup screen never sticks. */
  async function exitToOnboardingTab() {
    clearDappPendingRef.current()
    setPage('main')
    setRoute('home')
    onboardingTabOpenedRef.current = true
    try {
      await openOnboardingTab()
    } catch {
      // Tab open is best-effort; still try to close this surface.
    }
    await closeWalletSurface(surface)
  }

  async function logout() {
    setError(null)
    setLoading('Logging out…')
    try {
      const res = await sendToBackground<undefined, undefined>({
        type: 'LOGOUT',
        payload: undefined,
      })
      if (!res.ok) throw new Error(friendlyError(res.error))
      applyAccountsSnapshot({ accounts: [], activeAccountId: undefined })
      setLoading(null)
      await exitToOnboardingTab()
    } finally {
      setLoading(null)
    }
  }

  /** Removes the account from this install only; the wallet stays on-chain. */
  async function deleteAccount(accountId: string) {
    const res = await sendToBackground<DeleteAccountRequest, DeleteAccountResponse>({
      type: 'DELETE_ACCOUNT',
      payload: { accountId },
    })
    if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
    // Apply the delete payload immediately so View Accounts drops the row without
    // waiting on a follow-up GET (mnemonic unlock flags refreshed below when needed).
    applyAccountsSnapshot({
      accounts: res.data.accounts,
      activeAccountId: res.data.activeAccountId,
    })
    if (res.data.removedLastAccount || res.data.accounts.length === 0) {
      await exitToOnboardingTab()
      return
    }
    // Refresh mnemonic vault / signer flags for the new active account when needed.
    await refreshAccounts()
  }

  const containerClass =
    surface === 'sidepanel' ? 'h-screen w-full min-w-[320px]' : 'h-[600px] w-[360px]'
  const flowHeightClass = surface === 'sidepanel' ? 'flex-1 min-h-0' : 'h-[520px]'
  const showTopHeader = page === 'main' && !needsMnemonicUnlock && route === 'migration'
  // Home shell waits on portfolio only. History (Horizon + SAC) can be slow; gating
  // the whole home UI on it left a stuck "Loading..." overlay after the heavier fetch.
  const showAccountsHydrateOverlay =
    !loading && (!accountsHydrated || (!accountsLoadSucceeded && accounts.length === 0))
  const showHomeLoadingOverlay =
    !showAccountsHydrateOverlay &&
    (page === 'main' || page === 'settings') &&
    route === 'home' &&
    !loading &&
    !portfolioHydrated &&
    portfolioLoading
  const showSwapCatalogLoadingOverlay =
    (page === 'main' || page === 'settings') &&
    route === 'swap' &&
    !loading &&
    swapOverlayFlags.catalogLoading &&
    swapOverlayFlags.payCatalogEmpty
  const showSwapLoadingOverlay =
    swapOverlayFlags.swapBusy && route === 'swapConfirm' && swapOverlayFlags.swapStep === 'confirm'
  const routeContentMarginClass = showTopHeader ? 'mt-2' : 'mt-0'

  useMultisigJoinTokenOnMount((token) => {
    setMultisigJoinToken(token)
    setRoute('joinMultisig')
  })

  const multisigRoutes = MULTISIG_ROUTES
  const isMultisigRoute = multisigRoutes.includes(route as Route)

  const mainTabRoutes = ['home', 'swap', 'history', 'explore'] as const
  const showMainBottomNav =
    !needsMnemonicUnlock && (mainTabRoutes as readonly string[]).includes(route)
  const activeMainTab: MainTab =
    route === 'swap'
      ? 'swap'
      : route === 'history'
        ? 'history'
        : route === 'explore'
          ? 'explore'
          : 'home'

  return (
    <div className={['relative bg-bg text-fg', containerClass].join(' ')}>
      <div
        className={[
          'relative flex h-full w-full min-h-0 flex-col',
          surface === 'sidepanel' ? 'px-6 pt-4' : 'px-6 pt-3',
          showMainBottomNav ? 'pb-0' : 'pb-6',
        ].join(' ')}
      >
        {showTopHeader ? (
          <div className="flex items-center justify-between gap-2">
            <AccountMenu
              accountLabel={activeAccountLabel}
              accounts={accounts}
              activeAccountId={activeAccountId}
              onSelectAccount={(accountId) => {
                void sendToBackground<SetActiveAccountRequest, undefined>({
                  type: 'SET_ACTIVE_ACCOUNT',
                  payload: { accountId },
                })
                  .then(() => refreshAccounts())
                  .then((result) => {
                    if (!result) return
                    setRoute((prev) =>
                      resolveMainRoute({
                        needsMnemonicUnlock: result.needsMnemonicUnlock,
                        preferred: ROUTES_GATED_BY_MNEMONIC_UNLOCK.includes(prev) ? prev : 'home',
                      })
                    )
                  })
                  .catch(() => {})
              }}
              onAddAccount={() => setRoute('addAccount')}
              onRenameAccount={(accountId) => {
                const idx = accounts.findIndex((a) => a.id === accountId)
                const acc = accounts[idx]
                if (!acc) return
                setRenameDraft(storedAccountLabel(acc, idx >= 0 ? idx : 0))
                setRenameAccountId(accountId)
              }}
            />
          </div>
        ) : null}

        {page === 'main' || page === 'settings' ? (
          <>
            {loading && !routeKeepsUiMountedForWebauthn(route) ? (
              <FullScreenLoaderOverlay
                label={loading}
                description="Approve the request in your wallet when prompted."
                onCancel={() => setLoading(null)}
              />
            ) : null}

            {error && (!loading || routeKeepsUiMountedForWebauthn(route)) ? (
              <div
                className={`${routeContentMarginClass} rounded-2xl border border-border bg-surface/60 p-4 text-sm shadow-soft`}
              >
                <div className="font-extrabold">Something went wrong</div>
                <div className="mt-2 text-muted">{error}</div>
                <button
                  className="mt-4 rounded-full border border-border px-4 py-2 text-sm font-bold hover:bg-surface/70"
                  onClick={() => setError(null)}
                >
                  Dismiss
                </button>
              </div>
            ) : null}

            <DappRouteViews
              route={route}
              surface={surface}
              activeAccount={activeAccount}
              accountsLength={accounts.length}
              routeContentMarginClass={routeContentMarginClass}
              flowHeightClass={flowHeightClass}
              loading={loading}
              onSetRoute={setRoute}
              onSetError={setError}
              onResetOnboardingTabOpened={() => {
                onboardingTabOpenedRef.current = false
              }}
              registerClearPending={(clear) => {
                clearDappPendingRef.current = clear
              }}
            />

            {!loading && showOnboardingTabPrompt ? (
              <OpenSetupTabScreen
                routeContentMarginClass={routeContentMarginClass}
                flowHeightClass={flowHeightClass}
                onOpenSetupTab={() => {
                  onboardingTabOpenedRef.current = true
                  void openOnboardingTab().catch(() => {})
                }}
              />
            ) : null}

            {!loading && !showOnboardingTabPrompt && isMultisigRoute ? (
              <div
                className={[
                  routeContentMarginClass,
                  'flex min-h-0 flex-1 flex-col animate-screenIn',
                  flowHeightClass,
                ].join(' ')}
              >
                <MultisigRouteViews
                  route={route}
                  surface={surface}
                  activeAccount={activeAccount}
                  accounts={accounts}
                  externalJoinToken={multisigJoinToken}
                  externalProposalId={multisigDetailProposalId}
                  onRefreshAccounts={async () => {
                    await refreshAccounts()
                  }}
                  onSetRoute={(r) => setRoute(r as Route)}
                  onSetActiveAccountId={(id) => {
                    setActiveAccountId(id)
                    void sendToBackground<SetActiveAccountRequest, undefined>({
                      type: 'SET_ACTIVE_ACCOUNT',
                      payload: { accountId: id },
                    }).catch(() => {})
                  }}
                />
              </div>
            ) : null}

            <AccountRouteViews
              route={route}
              surface={surface}
              accounts={accounts}
              activeAccount={activeAccount}
              showOnboardingTabPrompt={showOnboardingTabPrompt}
              unlockReturnRoute={unlockReturnRoute}
              routeContentMarginClass={routeContentMarginClass}
              flowHeightClass={flowHeightClass}
              loading={loading}
              error={error}
              onSetLoading={setLoading}
              onSetError={setError}
              onSetRoute={setRoute}
              onSetUnlockReturnRoute={setUnlockReturnRoute}
              onRefreshAccounts={refreshAccounts}
              onPersistSetupHasAccount={persistSetupHasAccount}
            />

            {!loading && route === 'home' && !needsMnemonicUnlock && !showOnboardingTabPrompt ? (
              <div
                className={[
                  routeContentMarginClass,
                  'relative flex min-h-0 flex-1 flex-col animate-screenIn',
                ].join(' ')}
              >
                <HomeScreen
                  accountName={activeAccountLabel}
                  onOpenSettings={() => setPage('settings')}
                  onOpenExplore={() => setRoute('explore')}
                  onOpenHistory={() => setRoute('history')}
                  recentActivity={recentActivityItems}
                  totalBalanceUsd={totalBalanceUsd}
                  balanceChangePercent="0.00%"
                  showPendingMultisigDot={hasPendingMultisigProposals}
                  onOpenSwap={activeAccount?.mode === 'multisig' ? () => {} : openSwapFromNav}
                  swapDisabled={activeAccount?.mode === 'multisig'}
                  onOpenSend={openSendFlow}
                  onOpenReceive={() => setRoute('receive')}
                  onOpenFund={() => setRoute('fund')}
                  onSelectActivity={(it) => {
                    const c = activeAccount?.smartAccountAddress ?? ''
                    setTransactionDetailReturnRoute('home')
                    setTransactionDetail(buildTransactionDetail(it, c, networkLabel))
                    setRoute('transactionDetail')
                  }}
                />
                {page === 'settings' ? (
                  <>
                    <div
                      className={[
                        'absolute bottom-0 -left-6 -right-6 z-40 bg-overlay/90',
                        surface === 'sidepanel' ? '-top-4' : '-top-3',
                      ].join(' ')}
                      aria-hidden
                    />
                    <div
                      className={[
                        'absolute bottom-0 -left-6 -right-6 z-50',
                        surface === 'sidepanel' ? '-top-4' : '-top-3',
                      ].join(' ')}
                    >
                      <SettingsScreen
                        surface={surface}
                        accountName={activeAccountLabel}
                        accountAddress={activeAccount?.smartAccountAddress ?? '—'}
                        accounts={accounts.map((account, index) => ({
                          id: account.id,
                          name: storedAccountLabel(account, index),
                          address: account.smartAccountAddress,
                          mode: account.mode,
                        }))}
                        activeAccountId={activeAccountId}
                        biometricsEnabled={false}
                        onChangeBiometricsEnabled={() => {}}
                        sidePanelEnabled={pref === 'sidepanel'}
                        onChangeSidePanelEnabled={(enabled) => {
                          const next = enabled ? 'sidepanel' : 'popup'
                          setPref(next)
                          void setDefaultSurface(next).then(() => {
                            if (next === 'sidepanel') void openSidePanel().catch(() => {})
                          })
                        }}
                        onSaveAccountName={(walletName) => {
                          if (!activeAccount?.id) return
                          void sendToBackground<{ accountId: string; label?: string }, undefined>({
                            type: 'RENAME_ACCOUNT',
                            payload: {
                              accountId: activeAccount.id,
                              label: walletName,
                            },
                          })
                            .then(() => refreshAccounts())
                            .catch(() => {})
                        }}
                        onSelectAccount={(accountId) => {
                          void sendToBackground<SetActiveAccountRequest, undefined>({
                            type: 'SET_ACTIVE_ACCOUNT',
                            payload: { accountId },
                          })
                            .then(() => refreshAccounts())
                            .catch(() => {})
                        }}
                        onAccountsChanged={() => {
                          void refreshAccounts().catch(() => {})
                        }}
                        onCreateMultisig={() => {
                          setPage('main')
                          setRoute('createMultisig')
                        }}
                        onAddExistingMultisig={() => {
                          setPage('main')
                          setRoute('addExistingMultisig')
                        }}
                        onDeleteAccount={deleteAccount}
                        onOpenMultisigWallets={() => {
                          setPage('main')
                          setRoute('multisigWallets')
                        }}
                        onOpenMultisigProposals={
                          activeAccount?.mode === 'multisig'
                            ? () => {
                                setPage('main')
                                setRoute('multisigProposals')
                              }
                            : undefined
                        }
                        pendingMultisigProposalCount={
                          activeAccount?.mode === 'multisig' ? multisigPendingCount : 0
                        }
                        networkLabel={networkLabel}
                        activeNetwork={activeNetwork}
                        onChangeNetwork={async (network) => {
                          const res = await sendToBackground<
                            { network: 'testnet' | 'mainnet' },
                            { network: 'testnet' | 'mainnet'; networkLabel: string }
                          >({
                            type: 'SET_ACTIVE_NETWORK',
                            payload: { network },
                          })
                          if (!res.ok || !res.data) {
                            throw new Error(res.error?.message ?? 'Failed to switch network')
                          }
                          setActiveNetwork(res.data.network)
                          setNetworkLabel(
                            res.data.networkLabel ||
                              (res.data.network === 'mainnet'
                                ? 'Stellar Mainnet'
                                : 'Stellar Testnet')
                          )
                          const setupRes = await sendToBackground<undefined, GetSetupStateResponse>(
                            {
                              type: 'GET_SETUP_STATE',
                              payload: undefined,
                            }
                          )
                          if (setupRes.ok && setupRes.data) setSetupState(setupRes.data.setupState)
                          await refreshAccounts()
                        }}
                        onClose={() => setPage('main')}
                        onLogout={logout}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {!loading && route === 'explore' && !needsMnemonicUnlock ? (
              <div
                className={[
                  routeContentMarginClass,
                  'flex min-h-0 flex-1 flex-col animate-screenIn',
                  flowHeightClass,
                ].join(' ')}
              >
                <ExploreScreen onBack={() => setRoute('home')} />
              </div>
            ) : null}

            {!loading && route === 'migration' && activeAccount?.id ? (
              <div
                className={[
                  `${routeContentMarginClass} flex min-h-0 flex-1 flex-col animate-screenIn`,
                  flowHeightClass,
                ].join(' ')}
              >
                <MigrationScreen
                  surface={surface}
                  accountId={activeAccount.id}
                  network={activeNetwork}
                  onBack={() =>
                    setRoute(resolveMainRoute({ needsMnemonicUnlock, preferred: 'home' }))
                  }
                  onDone={() => setRoute('migrationSuccess')}
                  onNeedUnlock={() => {
                    setUnlockReturnRoute('migration')
                    setRoute('unlockMnemonic')
                  }}
                />
              </div>
            ) : null}

            {!loading && route === 'migrationSuccess' ? (
              <MigrationSuccessScreen
                routeContentMarginClass={routeContentMarginClass}
                flowHeightClass={flowHeightClass}
                onBackToHome={() => {
                  if (activeAccount?.id) {
                    void markMigrationHomePromoCompleted(activeAccount.id)
                  }
                  void loadPortfolio()
                  setRoute(resolveMainRoute({ needsMnemonicUnlock, preferred: 'home' }))
                }}
              />
            ) : null}

            {!loading && route === 'history' ? (
              <div
                className={[
                  `${routeContentMarginClass} flex min-h-0 flex-1 flex-col animate-screenIn`,
                  flowHeightClass,
                ].join(' ')}
              >
                <HistoryScreen
                  surface={surface}
                  sections={historySections}
                  loading={historyLoading}
                  error={historyError}
                  onBack={() => setRoute('home')}
                  onRefresh={() => void loadHistory({ force: true })}
                  onSelectItem={(it) => {
                    const c = activeAccount?.smartAccountAddress ?? ''
                    setTransactionDetailReturnRoute('history')
                    setTransactionDetail(buildTransactionDetail(it, c, networkLabel))
                    setRoute('transactionDetail')
                  }}
                />
              </div>
            ) : null}

            {!loading && route === 'transactionDetail' && transactionDetail ? (
              <div
                className={[
                  `${routeContentMarginClass} flex min-h-0 flex-1 flex-col animate-screenIn`,
                  flowHeightClass,
                ].join(' ')}
              >
                <TransactionDetailScreen
                  surface={surface}
                  detail={transactionDetail}
                  network={activeNetwork}
                  onBack={() => setRoute(transactionDetailReturnRoute)}
                />
              </div>
            ) : null}

            <SwapRouteViews
              route={route}
              surface={surface}
              activeAccount={activeAccount}
              setupState={setupState}
              routeContentMarginClass={routeContentMarginClass}
              flowHeightClass={flowHeightClass}
              loading={loading}
              onSetRoute={setRoute}
              onLoadPortfolio={() => void loadPortfolio()}
              onOverlayFlags={setSwapOverlayFlags}
              registerOpenSwap={(open) => {
                openSwapRef.current = open
              }}
            />

            <SendRouteViews
              route={route}
              surface={surface}
              activeAccount={activeAccount}
              accounts={accounts}
              activeNetwork={activeNetwork}
              networkLabel={networkLabel}
              portfolioRows={portfolioRows}
              portfolioLoading={portfolioLoading}
              portfolioError={portfolioError}
              routeContentMarginClass={routeContentMarginClass}
              flowHeightClass={flowHeightClass}
              loading={loading}
              onSetRoute={setRoute}
              onLoadPortfolio={() => void loadPortfolio()}
              onLoadMultisigProposals={() => void loadMultisigProposals()}
              onSetMultisigDetailProposalId={setMultisigDetailProposalId}
              registerOpenSend={(open) => {
                openSendRef.current = open
              }}
            />

            {!loading && route === 'receive' ? (
              <div
                className={[
                  `${routeContentMarginClass} flex min-h-0 flex-1 flex-col animate-screenIn`,
                  flowHeightClass,
                ].join(' ')}
              >
                <ReceiveFlow
                  smartAccountAddress={activeAccount?.smartAccountAddress || ''}
                  portfolioRows={portfolioRows}
                  portfolioLoading={portfolioLoading}
                  portfolioError={portfolioError}
                  onBackToHome={() => setRoute('home')}
                />
              </div>
            ) : null}

            {!loading && route === 'fund' ? (
              <div
                className={[
                  `${routeContentMarginClass} flex min-h-0 flex-1 flex-col animate-screenIn`,
                  flowHeightClass,
                ].join(' ')}
              >
                <FundScreen
                  accountId={activeAccount?.id || ''}
                  accountMode={activeAccount?.mode || ''}
                  passkeyCredentialId={activeAccount?.passkeyCredentialId}
                  surface={surface}
                  onBack={() => setRoute('home')}
                  onOpenReceive={() => setRoute('receive')}
                />
              </div>
            ) : null}
          </>
        ) : null}

        {renameAccountId ? (
          <RenameAccountDialog
            renameDraft={renameDraft}
            onDraftChange={setRenameDraft}
            onCancel={() => setRenameAccountId(null)}
            onSave={() => {
              if (!renameAccountId) return
              void sendToBackground<{ accountId: string; label?: string }, undefined>({
                type: 'RENAME_ACCOUNT',
                payload: {
                  accountId: renameAccountId,
                  label: renameDraft.trim() || undefined,
                },
              })
                .then(() => refreshAccounts())
                .then(() => setRenameAccountId(null))
                .catch(() => {})
            }}
          />
        ) : null}
      </div>

      {showMainBottomNav ? (
        <MainBottomNav active={activeMainTab} onSelect={handleMainTabSelect} />
      ) : null}

      {showAccountsHydrateOverlay ? (
        <div className="absolute inset-0 z-40">
          <HomeLoadingOverlay />
        </div>
      ) : null}

      {showHomeLoadingOverlay ? (
        <div className="absolute inset-0 z-40">
          <HomeLoadingOverlay />
        </div>
      ) : null}

      {showSwapCatalogLoadingOverlay ? (
        <div
          className="absolute inset-0 z-40"
          role="status"
          aria-live="polite"
          aria-label="Loading tokens"
        >
          <SwapCatalogLoadingOverlay />
        </div>
      ) : null}

      {showSwapLoadingOverlay ? (
        <div
          className="absolute inset-0 z-50"
          role="status"
          aria-live="polite"
          aria-label="Swapping"
        >
          <SwapTransactionLoadingOverlay />
        </div>
      ) : null}
    </div>
  )
}
