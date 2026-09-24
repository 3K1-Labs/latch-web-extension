import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  BackgroundMessage,
  ListPendingDappRequestsResponse,
  PendingDappRequest,
  StoredAccount,
} from '@latch/types'

import { GrantAccessScreen } from '../screens/dapp/GrantAccessScreen'
import { ExternalSignReviewScreen } from '../screens/dapp/ExternalSignReviewScreen'
import { friendlyError, logLatchError, sendToBackground } from '../lib/backgroundClient'
import { clearPendingWalletOutcome, writePendingWalletOutcome } from '../../lib/walletOutcome'
import { openOnboardingTab } from '../onboarding/openOnboardingTab'
import type { Route, Surface } from '../routing/routes'

export function DappRouteViews({
  route,
  surface,
  activeAccount,
  accountsLength,
  routeContentMarginClass,
  flowHeightClass,
  loading,
  onSetRoute,
  onSetError,
  onResetOnboardingTabOpened,
  registerClearPending,
}: {
  route: Route | string
  surface: Surface
  activeAccount: StoredAccount | undefined
  accountsLength: number
  routeContentMarginClass: string
  flowHeightClass: string
  loading: string | null
  onSetRoute: (route: Route | ((prev: Route) => Route)) => void
  onSetError: (v: string | null) => void
  onResetOnboardingTabOpened: () => void
  registerClearPending?: (clear: () => void) => void
}) {
  const [pendingDappRequests, setPendingDappRequests] = useState<PendingDappRequest[]>([])
  const [dappBusy, setDappBusy] = useState(false)
  const [dappError, setDappError] = useState<string | null>(null)
  const [dappProgressLabel, setDappProgressLabel] = useState<string | null>(null)
  const pendingDappRequestsRef = useRef(pendingDappRequests)
  pendingDappRequestsRef.current = pendingDappRequests
  const [dappNetwork, setDappNetwork] = useState<'testnet' | 'mainnet'>('testnet')

  useLayoutEffect(() => {
    registerClearPending?.(() => setPendingDappRequests([]))
  }, [registerClearPending])

  async function loadPendingDapp() {
    const res = await sendToBackground<unknown, ListPendingDappRequestsResponse>({
      type: 'LIST_PENDING_DAPP_REQUESTS',
      payload: {},
    })
    if (!res.ok || !res.data) return
    setPendingDappRequests(res.data.requests)
    if (res.data.requests.length > 0) {
      const netRes = await sendToBackground<undefined, { network: 'testnet' | 'mainnet' }>({
        type: 'GET_ACTIVE_NETWORK',
        payload: undefined,
      })
      if (netRes.ok && netRes.data?.network) setDappNetwork(netRes.data.network)
      onSetRoute('dappApproval')
      return
    }
    setDappBusy(false)
    setDappProgressLabel(null)
    setDappError(null)
    onSetRoute((prev) => (prev === 'dappApproval' ? 'home' : prev))
  }

  async function resolvePendingDapp(
    req: PendingDappRequest,
    approved: boolean,
    extra?: {
      signedXdr?: string
      txHash?: string
      signedAuthEntry?: string
      signedTxXdr?: string
      errorMessage?: string
      errorCode?: string
    }
  ) {
    await sendToBackground({
      type: 'RESOLVE_PENDING_DAPP_REQUEST',
      payload: {
        requestId: req.id,
        approved,
        errorMessage: extra?.errorMessage,
        errorCode: extra?.errorCode,
        signedXdr: extra?.signedXdr,
        txHash: extra?.txHash,
        signedAuthEntry: extra?.signedAuthEntry,
        signedTxXdr: extra?.signedTxXdr,
      },
    })
    setDappBusy(false)
    setDappProgressLabel(null)
    setDappError(null)
    await loadPendingDapp()
    if (pendingDappRequests.length <= 1) {
      onSetRoute(accountsLength > 0 ? 'home' : 'home')
      if (accountsLength === 0) {
        onResetOnboardingTabOpened()
        // Setup screen follows; tab open is best-effort.
        void openOnboardingTab().catch((e) => {
          logLatchError('dapp:open-onboarding', e)
        })
      }
    }
  }

  useEffect(() => {
    // Prefetch pending list — do not toast on every popup open.
    void loadPendingDapp().catch((e) => {
      logLatchError('dapp:list-pending', e)
    })
    // Mount-only, matches LatchRoot.
  }, [])

  useEffect(() => {
    function onStorage(changes: { [key: string]: chrome.storage.StorageChange }, area: string) {
      if (area !== 'session') return
      if (changes['latch.dappRequests']) {
        void loadPendingDapp().catch((e) => {
          logLatchError('dapp:list-pending', e)
        })
      }
    }
    chrome.storage.onChanged.addListener(onStorage)
    return () => chrome.storage.onChanged.removeListener(onStorage)
    // Listener is stable; deps intentionally empty.
  }, [])

  // Action popup / side panel close must reject pending reviews.
  useEffect(() => {
    function dismissPendingOnClose() {
      const pending = pendingDappRequestsRef.current
      if (pending.length === 0) return
      for (const req of pending) {
        void chrome.runtime.sendMessage({
          type: 'RESOLVE_PENDING_DAPP_REQUEST',
          payload: { requestId: req.id, approved: false },
        } satisfies BackgroundMessage<{ requestId: string; approved: boolean }>)
      }
    }
    window.addEventListener('pagehide', dismissPendingOnClose)
    return () => window.removeEventListener('pagehide', dismissPendingOnClose)
  }, [])

  async function confirmExternalSign(req: PendingDappRequest) {
    if (!req.prepared || !activeAccount) return
    if (req.localReview?.confirmBlocked) return

    setDappBusy(true)
    setDappError(null)
    try {
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'dapp',
          status: 'in_progress',
          payload: { requestId: req.id },
        })
      }

      const submit = req.signRequest?.submit !== false
      const res = await sendToBackground<
        {
          requestId: string
          accountId: string
          prepared: NonNullable<PendingDappRequest['prepared']>
          submit: boolean
          surface: Surface
        },
        {
          signedTxXdr?: string
          signedAuthEntry?: string
          txHash?: string
        }
      >({
        type: 'EXECUTE_DAPP_EXTERNAL_SIGN',
        payload: {
          requestId: req.id,
          accountId: activeAccount.id,
          prepared: req.prepared,
          submit,
          surface,
        },
      })
      if (!res.ok) throw new Error(friendlyError(res.error) || 'Signing failed.')

      setDappBusy(false)
      setDappProgressLabel(null)
      setDappError(null)
      await clearPendingWalletOutcome()
      await loadPendingDapp()
      if (pendingDappRequests.length <= 1) {
        onSetRoute(accountsLength > 0 ? 'home' : 'home')
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      onSetError(message)
      setDappError(message)
      setDappBusy(false)
      setDappProgressLabel(null)
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'dapp',
          status: 'failure',
          error: message,
        }).catch((err) => {
          logLatchError('dapp:pending-outcome', err)
        })
      }
    }
  }

  if (loading || route !== 'dappApproval') return null

  return (
    <div
      className={[routeContentMarginClass, 'flex flex-col animate-screenIn', flowHeightClass].join(
        ' '
      )}
    >
      {pendingDappRequests[0]?.kind === 'externalSignReview' && pendingDappRequests[0].prepared ? (
        <ExternalSignReviewScreen
          origin={pendingDappRequests[0].origin}
          prepared={pendingDappRequests[0].prepared}
          localReview={pendingDappRequests[0].localReview}
          busy={dappBusy}
          progressLabel={dappProgressLabel}
          error={dappError}
          onConfirm={() => {
            const req = pendingDappRequests[0]
            if (!req) return
            void confirmExternalSign(req)
          }}
          onReject={() => {
            const req = pendingDappRequests[0]
            if (!req) return
            void resolvePendingDapp(req, false).catch((e) =>
              setDappError(e instanceof Error ? e.message : String(e))
            )
          }}
        />
      ) : pendingDappRequests[0] ? (
        <GrantAccessScreen
          origin={pendingDappRequests[0].origin}
          kind={pendingDappRequests[0].kind}
          network={dappNetwork}
          smartAccountAddress={activeAccount?.smartAccountAddress ?? '—'}
          busy={dappBusy}
          onApprove={() => {
            const req = pendingDappRequests[0]
            if (!req) return
            void resolvePendingDapp(req, true).catch((e) =>
              setDappError(e instanceof Error ? e.message : String(e))
            )
          }}
          onReject={() => {
            const req = pendingDappRequests[0]
            if (!req) return
            void resolvePendingDapp(req, false).catch((e) =>
              setDappError(e instanceof Error ? e.message : String(e))
            )
          }}
        />
      ) : null}
    </div>
  )
}
