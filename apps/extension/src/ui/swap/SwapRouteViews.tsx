import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'

import type {
  GetAssetIconDataUrlsRequest,
  GetAssetIconDataUrlsResponse,
  GetMarketPricesRequest,
  GetMarketPricesResponse,
  GetSwapQuoteRequest,
  GetSwapQuoteResponse,
  GetSwapTokenCatalogRequest,
  GetSwapTokenCatalogResponse,
  StoredAccount,
} from '@latch/types'

import { SwapScreen, swapWalletLabel } from '../screens/SwapScreen'
import { ConfirmSwapScreen } from '../screens/ConfirmSwapScreen'
import { SwapFailureScreen } from '../screens/swap/SwapFailureScreen'
import { SwapSuccessScreen } from '../screens/swap/SwapSuccessScreen'
import { friendlyError, logLatchError, sendToBackground } from '../lib/backgroundClient'
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

  async function refreshSwapQuoteForConfirm(): Promise<SwapQuoteVm> {
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
    const refreshed = swapQuotePayloadToVm(res.data.quote, payUsd, receiveUsd)
    setSwapQuote(refreshed)
    return refreshed
  }

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

  async function handleConfirmSwap() {
    if (!activeAccount?.id || !swapQuote || !swapDraft) return

    setSwapBusy(true)
    setSwapFailureDetail(null)
    try {
      const quoteForTx =
        swapQuote.quotePayload.providerId === 'soroswap' ||
        Date.now() >= swapQuote.quotePayload.expiresAtMs - 5_000
          ? await refreshSwapQuoteForConfirm()
          : swapQuote

      const outcomePayload = { draft: swapDraft, quote: quoteForTx }
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'swap',
          status: 'in_progress',
          payload: outcomePayload,
        })
      }

      const res = await sendToBackground<
        {
          accountId: string
          quote: typeof quoteForTx.quotePayload
          surface: Surface
          outcomePayload?: Record<string, unknown>
        },
        {
          prepared: {
            estimatedFeeXlm?: string
            feeLabel?: string
          }
          submit: { transactionHash?: string; hash?: string }
        }
      >({
        type: 'EXECUTE_SWAP_CONFIRM',
        payload: {
          accountId: activeAccount.id,
          quote: quoteForTx.quotePayload,
          surface,
          outcomePayload,
        },
      })
      if (!res.ok) throw new Error(friendlyError(res.error) || 'Swap failed.')

      const prepared = res.data!.prepared
      if (prepared.estimatedFeeXlm || prepared.feeLabel) {
        setSwapQuote((prev) =>
          prev
            ? {
                ...prev,
                networkFeeLine: prepared.feeLabel
                  ? prepared.feeLabel
                  : `~ ${prepared.estimatedFeeXlm} Stellar`,
              }
            : prev
        )
      }

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
