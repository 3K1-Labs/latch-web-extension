import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  BackgroundMessage,
  ListPendingDappRequestsResponse,
  PendingDappRequest,
  StoredAccount,
} from '@latch/types'

import { GrantAccessScreen } from '../screens/dapp/GrantAccessScreen'
import { ExternalSignReviewScreen } from '../screens/dapp/ExternalSignReviewScreen'
import {
  extractTransactionHash,
  signAndSubmitBuiltTx,
  signWithoutSubmitBuiltTx,
} from '../lib/signBuiltTx'
import { sendToBackground } from '../lib/backgroundClient'
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
  const pendingDappRequestsRef = useRef(pendingDappRequests)
  pendingDappRequestsRef.current = pendingDappRequests
  const [dappProgressLabel, setDappProgressLabel] = useState<string | null>(null)
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
        void openOnboardingTab().catch(() => {})
      }
    }
  }

  useEffect(() => {
    void loadPendingDapp().catch(() => {})
    // Mount-only, matches LatchRoot.
  }, [])

  useEffect(() => {
    function onStorage(changes: { [key: string]: chrome.storage.StorageChange }, area: string) {
      if (area !== 'local') return
      if (changes['latch.pendingDappRequests']) {
        void loadPendingDapp().catch(() => {})
      }
    }
    chrome.storage.onChanged.addListener(onStorage)
    return () => chrome.storage.onChanged.removeListener(onStorage)
    // Listener is stable; deps intentionally empty.
  }, [])

  // Action popup / side panel close must reject pending reviews. The fallback
  // chrome.windows.create path already does this; chrome.action.openPopup does not.
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
            if (!req?.prepared || !activeAccount) return
            if (req.localReview?.confirmBlocked) return
            void (async () => {
              setDappBusy(true)
              setDappError(null)
              try {
                if (req.signRequest?.submit === false) {
                  const { signedTxXdr, signedAuthEntry } = await signWithoutSubmitBuiltTx({
                    build: req.prepared!,
                    activeAccount,
                    surface,
                    onProgress: setDappProgressLabel,
                  })
                  await resolvePendingDapp(req, true, {
                    signedTxXdr,
                    signedAuthEntry,
                  })
                  return
                }
                const submitData = await signAndSubmitBuiltTx({
                  build: req.prepared!,
                  activeAccount,
                  surface,
                  onProgress: setDappProgressLabel,
                })
                const txHash = extractTransactionHash(submitData)
                await resolvePendingDapp(req, true, { txHash })
              } catch (e) {
                const message = e instanceof Error ? e.message : String(e)
                // Clear the durable queue on failure so reopening the extension
                // does not resurrect a stale "Review transaction" screen.
                try {
                  await resolvePendingDapp(req, false, {
                    errorMessage: message,
                    errorCode: 'sign_failed',
                  })
                  onSetError(message)
                } catch {
                  setDappError(message)
                  setDappBusy(false)
                  setDappProgressLabel(null)
                }
              }
            })()
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
