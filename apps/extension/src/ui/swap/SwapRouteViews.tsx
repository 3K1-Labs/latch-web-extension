import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  BackgroundRequestPayloadByType,
  BackgroundResponseDataByType,
  GetAssetIconDataUrlsRequest,
  GetAssetIconDataUrlsResponse,
  GetMarketPricesRequest,
  GetMarketPricesResponse,
  GetSwapQuoteRequest,
  GetSwapQuoteResponse,
  GetSwapTokenCatalogRequest,
  GetSwapTokenCatalogResponse,
  NetworkFee,
  PrepareSwapTxRequest,
  PrepareSwapTxResponse,
  StoredAccount,
} from '@latch/types'

import { SwapScreen, swapWalletLabel } from '../screens/SwapScreen'
import { ConfirmSwapScreen } from '../screens/ConfirmSwapScreen'
import { SwapFailureScreen } from '../screens/swap/SwapFailureScreen'
import { SwapSuccessScreen } from '../screens/swap/SwapSuccessScreen'
import { friendlyError, logLatchError, sendToBackground } from '../lib/backgroundClient'
import {
  NETWORK_FEE_CHANGED_CODE,
  formatPreparedNetworkFeeLine,
  isUserPaidFeeErrorCode,
} from '../lib/networkFee'
import {
  clearPendingWalletOutcome,
  consumePendingWalletOutcomeIf,
  writePendingWalletOutcome,
} from '../../lib/walletOutcome'
import type { SwapDraft, SwapQuoteVm, SwapTokenVm } from '../swap/swapVm'
import {
  mergeSwapTokenCatalogs,
  pickDefaultReceiveTokenId,
  swapQuotePayloadToVm,
} from '../swap/swapVm'
import {
  shouldApplySwapQuoteRefresh,
  swapConfirmBlocked,
  swapQuoteMatchesDraft,
  swapQuoteRefreshAction,
  swapQuoteRefreshWaitMs,
} from '../swap/swapQuoteRefresh'
import type { Route, Surface } from '../routing/routes'

export type SwapOverlayFlags = {
  catalogLoading: boolean
  payCatalogEmpty: boolean
  swapBusy: boolean
  swapStep: string
}

export function SwapRouteViews({
  route,
  surface,
  activeAccount,
  setupState,
  routeContentMarginClass,
  flowHeightClass,
  loading,
  onSetRoute,
  onLoadPortfolio,
  onOverlayFlags,
  registerOpenSwap,
}: {
  route: Route | string
  surface: Surface
  activeAccount: StoredAccount | undefined
  setupState: string
  routeContentMarginClass: string
  flowHeightClass: string
  loading: string | null
  onSetRoute: (route: Route) => void
  onLoadPortfolio: () => void
  onOverlayFlags?: (flags: SwapOverlayFlags) => void
  registerOpenSwap?: (open: () => void) => void
}) {
  const [swapDraft, setSwapDraft] = useState<SwapDraft | null>(null)
  const [swapQuote, setSwapQuote] = useState<SwapQuoteVm | null>(null)
  const [swapPayTokenCatalog, setSwapPayTokenCatalog] = useState<SwapTokenVm[]>([])
  const [swapReceiveTokenCatalog, setSwapReceiveTokenCatalog] = useState<SwapTokenVm[]>([])
  const [swapPreferredReceiveTokenIds, setSwapPreferredReceiveTokenIds] = useState<string[]>([])
  const [swapCatalogLoading, setSwapCatalogLoading] = useState(false)
  const [swapBusy, setSwapBusy] = useState(false)
  const [swapStep, setSwapStep] = useState<'confirm' | 'success' | 'failure'>('confirm')
  const [swapFailureDetail, setSwapFailureDetail] = useState<string | null>(null)
  const [swapFeeError, setSwapFeeError] = useState<string | null>(null)
  const [swapReviewNotice, setSwapReviewNotice] = useState<string | null>(null)
  const [swapFeeLoading, setSwapFeeLoading] = useState(false)
  const [swapFeePrepareNonce, setSwapFeePrepareNonce] = useState(0)
  /** Fee the confirm screen displayed; the background refuses to sign a build it doesn't cover. */
  const [shownSwapNetworkFee, setShownSwapNetworkFee] = useState<NetworkFee | null>(null)
  const [quoteRefreshTick, setQuoteRefreshTick] = useState(0)
  /** Last time this confirm visit fetched each quote expiry. */
  const quoteAttemptedAtRef = useRef<Map<number, number>>(new Map())
  const confirmEntryExpiresRef = useRef<number | null>(null)
  /** Bumped when a refresh starts or this confirm visit ends, so a late response is dropped. */
  const quoteGenRef = useRef(0)
  /** Set when Confirm must load a quote for the amount on screen before it can sign. */
  const forceQuoteRefreshRef = useRef(false)
  /** True from the moment Confirm starts signing until that attempt settles. */
  const submitLockRef = useRef(false)
  const [swapTokenPriceUsdBySymbol, setSwapTokenPriceUsdBySymbol] = useState<
    Record<string, number>
  >({})
  const [swapIconByCode, setSwapIconByCode] = useState<Record<string, string | null>>({})

  const mapSwapTokenVm = useCallback(
    (t: {
      id: string
      symbol: string
      name: string
      assetId: string
      contractId: string
      decimals: number
      balance: string
      issuer?: string
      iconUrl?: string | null
    }): SwapTokenVm => ({
      id: t.id,
      symbol: t.symbol,
      name: t.name,
      assetId: t.assetId,
      contractId: t.contractId,
      decimals: t.decimals,
      balance: t.balance,
      issuer: t.issuer,
      iconUrl: t.iconUrl,
    }),
    []
  )

  const loadSwapCatalog = useCallback(async () => {
    if (!activeAccount?.id) return
    setSwapCatalogLoading(true)
    try {
      const res = await sendToBackground<GetSwapTokenCatalogRequest, GetSwapTokenCatalogResponse>({
        type: 'GET_SWAP_TOKEN_CATALOG',
        payload: { accountId: activeAccount.id },
      })
      if (res.ok && res.data) {
        setSwapPayTokenCatalog(res.data.payTokens.map(mapSwapTokenVm))
        setSwapReceiveTokenCatalog(res.data.receiveTokens.map(mapSwapTokenVm))
        setSwapPreferredReceiveTokenIds(res.data.preferredReceiveTokenIds)
      }
    } finally {
      setSwapCatalogLoading(false)
    }
  }, [activeAccount?.id, mapSwapTokenVm])

  useEffect(() => {
    if (route !== 'swap' && route !== 'swapConfirm') return
    void loadSwapCatalog()
  }, [route, loadSwapCatalog])

  const swapTokensUnion = useMemo(
    () => mergeSwapTokenCatalogs(swapPayTokenCatalog, swapReceiveTokenCatalog),
    [swapPayTokenCatalog, swapReceiveTokenCatalog]
  )

  useEffect(() => {
    if (route !== 'swap' && route !== 'swapConfirm') return
    const codes = swapTokensUnion.map((t) => t.symbol).filter(Boolean)
    if (codes.length === 0) return
    let cancelled = false
    void (async () => {
      const res = await sendToBackground<GetMarketPricesRequest, GetMarketPricesResponse>({
        type: 'GET_MARKET_PRICES',
        payload: { tokens: codes },
      })
      if (cancelled || !res.ok || !res.data) return
      const map: Record<string, number> = {}
      for (const [code, row] of Object.entries(res.data.pricesByCodeUpper)) {
        if (row?.priceUsd != null) map[code] = row.priceUsd
      }
      setSwapTokenPriceUsdBySymbol(map)
    })()
    return () => {
      cancelled = true
    }
  }, [route, swapTokensUnion])

  useEffect(() => {
    if (setupState !== 'has_account' || swapTokensUnion.length === 0) return
    let cancelled = false
    void (async () => {
      const res = await sendToBackground<GetAssetIconDataUrlsRequest, GetAssetIconDataUrlsResponse>(
        {
          type: 'GET_ASSET_ICON_DATA_URLS',
          payload: {
            assets: swapTokensUnion.map((t) => ({
              code: t.symbol,
              issuer: t.issuer,
              sacContractId: t.contractId,
            })),
          },
        }
      )
      if (cancelled || !res.ok || !res.data) return
      const map: Record<string, string | null> = {}
      swapTokensUnion.forEach((t, i) => {
        map[t.symbol] = res.data!.icons[i] ?? t.iconUrl ?? null
      })
      setSwapIconByCode(map)
    })()
    return () => {
      cancelled = true
    }
  }, [setupState, swapTokensUnion])

  const applySwapTokenIcons = useCallback(
    (catalog: SwapTokenVm[]) =>
      catalog.map((t) => ({
        ...t,
        iconUrl: swapIconByCode[t.symbol] ?? t.iconUrl ?? null,
      })),
    [swapIconByCode]
  )

  const swapPayTokenCatalogWithIcons = useMemo(
    () => applySwapTokenIcons(swapPayTokenCatalog),
    [applySwapTokenIcons, swapPayTokenCatalog]
  )

  const swapReceiveTokenCatalogWithIcons = useMemo(
    () => applySwapTokenIcons(swapReceiveTokenCatalog),
    [applySwapTokenIcons, swapReceiveTokenCatalog]
  )

  const swapTokenById = useMemo(() => {
    const map = new Map<string, SwapTokenVm>()
    for (const t of mergeSwapTokenCatalogs(
      swapPayTokenCatalogWithIcons,
      swapReceiveTokenCatalogWithIcons
    )) {
      map.set(t.id, t)
    }
    return map
  }, [swapPayTokenCatalogWithIcons, swapReceiveTokenCatalogWithIcons])

  const resolveSwapToken = useCallback((id: string) => swapTokenById.get(id), [swapTokenById])

  function resetSwapFlow() {
    setSwapDraft(null)
    setSwapQuote(null)
    setSwapBusy(false)
    setSwapStep('confirm')
    setSwapFailureDetail(null)
    setSwapFeeError(null)
    setSwapReviewNotice(null)
    setSwapFeeLoading(false)
    setShownSwapNetworkFee(null)
    setSwapFeePrepareNonce(0)
    quoteAttemptedAtRef.current.clear()
    confirmEntryExpiresRef.current = null
    forceQuoteRefreshRef.current = false
    submitLockRef.current = false
    quoteGenRef.current += 1
  }

  const openSwapFromNav = useCallback(() => {
    if (activeAccount?.mode === 'multisig') return
    const payId = swapPayTokenCatalogWithIcons[0]?.id ?? 'native'
    const receiveId = pickDefaultReceiveTokenId(
      payId,
      swapReceiveTokenCatalogWithIcons,
      swapPreferredReceiveTokenIds
    )
    setSwapDraft({
      payTokenId: payId,
      receiveTokenId: receiveId,
      payAmount: '',
      useExchangeBalance: false,
      approved: false,
    })
    setSwapQuote(null)
    setSwapStep('confirm')
    onSetRoute('swap')
    void loadSwapCatalog()
  }, [
    activeAccount?.mode,
    swapPayTokenCatalogWithIcons,
    swapReceiveTokenCatalogWithIcons,
    swapPreferredReceiveTokenIds,
    onSetRoute,
    loadSwapCatalog,
  ])

  useLayoutEffect(() => {
    registerOpenSwap?.(openSwapFromNav)
  }, [registerOpenSwap, openSwapFromNav])

  useEffect(() => {
    onOverlayFlags?.({
      catalogLoading: swapCatalogLoading,
      payCatalogEmpty: swapPayTokenCatalogWithIcons.length === 0,
      swapBusy,
      swapStep,
    })
  }, [onOverlayFlags, swapCatalogLoading, swapPayTokenCatalogWithIcons.length, swapBusy, swapStep])

  const refreshSwapQuoteForConfirm = useCallback(async (): Promise<SwapQuoteVm> => {
    if (!activeAccount?.id || !swapDraft || !swapQuote) {
      throw new Error('Swap session expired')
    }
    const payToken = resolveSwapToken(swapDraft.payTokenId)
    const receiveToken = resolveSwapToken(swapDraft.receiveTokenId)
    if (!payToken || !receiveToken) throw new Error('Unknown swap token')

    const res = await sendToBackground<GetSwapQuoteRequest, GetSwapQuoteResponse>({
      type: 'GET_SWAP_QUOTE',
      payload: {
        accountId: activeAccount.id,
        assetInId: payToken.id,
        assetOutId: receiveToken.id,
        amountIn: swapDraft.payAmount,
        slippageBps: swapQuote.quotePayload.slippageBps,
        providerId: swapQuote.quotePayload.providerId,
      },
    })
    if (!res.ok || !res.data) throw new Error(friendlyError(res.error) || 'Swap failed.')

    const payUsd = swapTokenPriceUsdBySymbol[payToken.symbol.toUpperCase()]
    const receiveUsd = swapTokenPriceUsdBySymbol[receiveToken.symbol.toUpperCase()]
    return swapQuotePayloadToVm(res.data.quote, payUsd, receiveUsd)
  }, [activeAccount?.id, resolveSwapToken, swapDraft, swapQuote, swapTokenPriceUsdBySymbol])

  const quotePayloadForFee = swapQuote?.quotePayload
  const quoteExpiresAt = quotePayloadForFee?.expiresAtMs
  const onConfirmScreen = route === 'swapConfirm' && swapStep === 'confirm'
  const refreshInput =
    onConfirmScreen && quoteExpiresAt != null && quotePayloadForFee
      ? {
          now: Date.now(),
          expiresAt: quoteExpiresAt,
          providerId: quotePayloadForFee.providerId,
          entryExpiresAt: confirmEntryExpiresRef.current,
          attemptedAt: quoteAttemptedAtRef.current.get(quoteExpiresAt) ?? null,
        }
      : null
  const quoteNeedsRefresh =
    refreshInput != null &&
    (forceQuoteRefreshRef.current || swapQuoteRefreshAction(refreshInput) === 'refresh')
  const quoteRemainingMs =
    quoteExpiresAt == null ? Number.POSITIVE_INFINITY : quoteExpiresAt - Date.now()
  const refreshQuoteRef = useRef(refreshSwapQuoteForConfirm)
  refreshQuoteRef.current = refreshSwapQuoteForConfirm

  useEffect(() => {
    if (!onConfirmScreen) {
      confirmEntryExpiresRef.current = null
      quoteAttemptedAtRef.current.clear()
      forceQuoteRefreshRef.current = false
      quoteGenRef.current += 1
      return
    }
    if (swapBusy) return
    if (!quoteNeedsRefresh || quoteExpiresAt == null || refreshInput == null) {
      const wait = refreshInput ? swapQuoteRefreshWaitMs(refreshInput) : null
      if (wait != null) {
        const id = window.setTimeout(() => setQuoteRefreshTick((n) => n + 1), wait)
        return () => window.clearTimeout(id)
      }
      return
    }
    const gen = ++quoteGenRef.current
    if (confirmEntryExpiresRef.current == null) confirmEntryExpiresRef.current = quoteExpiresAt
    setSwapFeeLoading(true)
    setShownSwapNetworkFee(null)
    void refreshQuoteRef
      .current()
      .then((vm) => {
        if (
          !shouldApplySwapQuoteRefresh({
            requestGen: gen,
            currentGen: quoteGenRef.current,
            submitting: submitLockRef.current,
          })
        ) {
          return
        }
        forceQuoteRefreshRef.current = false
        quoteAttemptedAtRef.current.set(quoteExpiresAt, Date.now())
        setSwapQuote(vm)
      })
      .catch((e) => {
        if (
          !shouldApplySwapQuoteRefresh({
            requestGen: gen,
            currentGen: quoteGenRef.current,
            submitting: submitLockRef.current,
          })
        ) {
          return
        }
        forceQuoteRefreshRef.current = false
        quoteAttemptedAtRef.current.set(quoteExpiresAt, Date.now())
        setSwapFeeLoading(false)
        setSwapFeeError(e instanceof Error ? e.message : String(e))
        logLatchError('swap:quote-refresh', e)
      })
    return () => {
      quoteGenRef.current += 1
    }
  }, [onConfirmScreen, swapBusy, quoteNeedsRefresh, quoteExpiresAt, quoteRefreshTick])

  useEffect(() => {
    if (
      route !== 'swapConfirm' ||
      swapStep !== 'confirm' ||
      !activeAccount?.id ||
      !quotePayloadForFee ||
      quoteNeedsRefresh
    ) {
      return
    }
    const preparedExpiresAt = quotePayloadForFee.expiresAtMs
    let cancelled = false
    setSwapFeeLoading(true)
    setSwapFeeError(null)
    setShownSwapNetworkFee(null)
    void sendToBackground<PrepareSwapTxRequest, PrepareSwapTxResponse>({
      type: 'PREPARE_SWAP_TX',
      payload: { accountId: activeAccount.id, quote: quotePayloadForFee },
    })
      .then((res) => {
        if (cancelled) return
        setSwapFeeLoading(false)
        if (res.ok && res.data) {
          setShownSwapNetworkFee(res.data.networkFee ?? null)
          setSwapReviewNotice(null)
          const line = formatPreparedNetworkFeeLine(res.data)
          if (line) {
            setSwapQuote((prev) =>
              prev && prev.quotePayload.expiresAtMs === preparedExpiresAt
                ? { ...prev, networkFeeLine: line }
                : prev
            )
          }
          return
        }
        setShownSwapNetworkFee(null)
        if (isUserPaidFeeErrorCode(res.error?.code)) {
          setSwapFeeError(friendlyError(res.error))
        }
      })
      .catch((e) => {
        if (cancelled) return
        setSwapFeeLoading(false)
        setShownSwapNetworkFee(null)
        logLatchError('swap:prepare-fee', e)
      })
    return () => {
      cancelled = true
    }
  }, [
    route,
    swapStep,
    activeAccount?.id,
    quotePayloadForFee,
    quoteNeedsRefresh,
    swapFeePrepareNonce,
  ])

  useEffect(() => {
    void (async () => {
      const outcome = await consumePendingWalletOutcomeIf('swap')
      if (!outcome || outcome.status === 'in_progress') return
      const payload = outcome.payload ?? {}
      if (payload.draft) setSwapDraft(payload.draft as SwapDraft)
      if (payload.quote) setSwapQuote(payload.quote as SwapQuoteVm)
      setSwapBusy(false)
      if (outcome.status === 'success') {
        setSwapStep('success')
        setSwapFailureDetail(null)
        void onLoadPortfolio()
      } else {
        setSwapStep('failure')
        setSwapFailureDetail(outcome.error ?? 'Swap failed.')
      }
      onSetRoute('swapConfirm')
    })()
  }, [onLoadPortfolio, onSetRoute])

  function refuseStaleQuote(message: string) {
    setSwapReviewNotice(message)
    setShownSwapNetworkFee(null)
    forceQuoteRefreshRef.current = true
    setQuoteRefreshTick((n) => n + 1)
  }

  async function handleConfirmSwap() {
    if (!activeAccount?.id || !swapQuote || !swapDraft) return
    if (swapFeeLoading || quoteNeedsRefresh || quoteRemainingMs <= 0) {
      if (quoteRemainingMs <= 0) {
        refuseStaleQuote('This quote expired. Review the updated price and fee.')
      }
      return
    }
    if (
      !swapQuoteMatchesDraft(
        swapDraft.payAmount,
        swapQuote.quotePayload.assetIn.decimals,
        swapQuote.quotePayload.amountInRaw
      )
    ) {
      refuseStaleQuote(
        "The quote doesn't match the amount on screen. Review the updated price and fee."
      )
      return
    }

    quoteGenRef.current += 1
    submitLockRef.current = true
    setSwapBusy(true)
    setSwapFailureDetail(null)
    try {
      const outcomePayload = { draft: swapDraft, quote: swapQuote }
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'swap',
          status: 'in_progress',
          payload: outcomePayload,
        })
      }

      const res = await sendToBackground<
        BackgroundRequestPayloadByType['EXECUTE_SWAP_CONFIRM'],
        BackgroundResponseDataByType['EXECUTE_SWAP_CONFIRM']
      >({
        type: 'EXECUTE_SWAP_CONFIRM',
        payload: {
          accountId: activeAccount.id,
          quote: swapQuote.quotePayload,
          shownNetworkFee: shownSwapNetworkFee,
          surface,
          outcomePayload,
        },
      })
      if (!res.ok && res.error?.code === NETWORK_FEE_CHANGED_CODE) {
        await clearPendingWalletOutcome()
        setSwapReviewNotice(friendlyError(res.error))
        setShownSwapNetworkFee(null)
        setSwapFeePrepareNonce((n) => n + 1)
        return
      }
      if (!res.ok) throw new Error(friendlyError(res.error) || 'Swap failed.')

      setSwapStep('success')
      await clearPendingWalletOutcome()
      void onLoadPortfolio()
      const submit = res.data!.submit
      const txHash =
        typeof submit.transactionHash === 'string'
          ? submit.transactionHash
          : typeof submit.hash === 'string'
            ? submit.hash
            : undefined
      if (txHash) console.info('[latch:swap] submitted', txHash)
    } catch (e) {
      console.error('[latch:swap]', e)
      setSwapFailureDetail(e instanceof Error ? e.message : String(e))
      setSwapStep('failure')
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'swap',
          status: 'failure',
          error: e instanceof Error ? e.message : String(e),
          payload: { draft: swapDraft, quote: swapQuote },
        }).catch((err) => {
          logLatchError('swap:pending-outcome', err)
        })
      }
    } finally {
      submitLockRef.current = false
      setSwapBusy(false)
    }
  }

  if (loading) return null
  if (route !== 'swap' && route !== 'swapConfirm') return null

  if (route === 'swap') {
    return (
      <div
        className={[
          routeContentMarginClass,
          'flex min-h-0 flex-1 flex-col animate-screenIn',
          flowHeightClass,
        ].join(' ')}
      >
        {!(swapCatalogLoading && swapPayTokenCatalogWithIcons.length === 0) ? (
          <SwapScreen
            surface={surface}
            accountId={activeAccount?.id ?? ''}
            walletLabel={swapWalletLabel(activeAccount?.smartAccountAddress)}
            initialState={swapDraft ?? undefined}
            payTokenCatalog={swapPayTokenCatalogWithIcons}
            receiveTokenCatalog={swapReceiveTokenCatalogWithIcons}
            preferredReceiveTokenIds={swapPreferredReceiveTokenIds}
            tokenPriceUsdBySymbol={swapTokenPriceUsdBySymbol}
            onBack={() => onSetRoute('home')}
            onContinue={(q, d) => {
              setSwapDraft(d)
              setSwapQuote(q)
              setSwapStep('confirm')
              onSetRoute('swapConfirm')
            }}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={[
        routeContentMarginClass,
        'flex min-h-0 flex-1 flex-col animate-screenIn',
        flowHeightClass,
      ].join(' ')}
    >
      {swapDraft && swapQuote ? (
        swapStep === 'success' ? (
          <SwapSuccessScreen
            draft={swapDraft}
            quote={swapQuote}
            resolveSwapToken={resolveSwapToken}
            onBackToHome={() => {
              resetSwapFlow()
              onSetRoute('home')
            }}
          />
        ) : swapStep === 'failure' ? (
          <SwapFailureScreen
            draft={swapDraft}
            quote={swapQuote}
            resolveSwapToken={resolveSwapToken}
            errorDetail={swapFailureDetail}
            onBack={() => {
              resetSwapFlow()
              onSetRoute('swap')
            }}
            onTryAgain={() => {
              setSwapFailureDetail(null)
              setSwapStep('confirm')
            }}
          />
        ) : (
          <ConfirmSwapScreen
            surface={surface}
            draft={swapDraft}
            quote={swapQuote}
            resolveSwapToken={resolveSwapToken}
            receiveAddress={activeAccount?.smartAccountAddress}
            busy={swapBusy}
            confirmDisabled={swapConfirmBlocked({
              remainingMs: quoteRemainingMs,
              refreshing: quoteNeedsRefresh,
              feeLoading: swapFeeLoading,
              feeError: swapFeeError != null,
            })}
            feeError={swapFeeError ?? swapReviewNotice}
            onBackOrCancel={() => {
              if (swapBusy) return
              onSetRoute('swap')
            }}
            onConfirm={() => {
              void handleConfirmSwap()
            }}
          />
        )
      ) : (
        <div className="rounded-2xl border border-border bg-surface/60 p-4 text-sm shadow-soft">
          <div className="font-extrabold">Swap session expired</div>
          <div className="mt-2 text-muted">Start a new swap from the dashboard.</div>
          <button
            className="mt-4 h-10 w-full rounded-full bg-primary text-sm font-extrabold text-black"
            onClick={() => onSetRoute('home')}
          >
            Back to Home
          </button>
        </div>
      )}
    </div>
  )
}
