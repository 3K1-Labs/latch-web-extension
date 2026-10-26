import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  BackgroundRequestPayloadByType,
  BackgroundResponseDataByType,
  GetSwapQuoteRequest,
  GetSwapQuoteResponse,
  NetworkFee,
  PrepareSwapTxRequest,
  PrepareSwapTxResponse,
  StoredAccount,
} from '@latch/types'

import { friendlyError, logLatchError, sendToBackground } from '../lib/backgroundClient'
import { formatPreparedNetworkFeeLine, isUserPaidFeeErrorCode } from '../lib/networkFee'
import { reviewedBuildStillValid, type ReviewedFee } from '../lib/reviewedBuild'
import {
  isNoContextRuleError,
  isPrepareSignMissingSetupError,
  isSwapRuleReconfigureError,
} from '../lib/sendTx'
import { swapBuildNeedsSignerReconfigure } from '../lib/swapTx'
import { clearPendingWalletOutcome, writePendingWalletOutcome } from '../../lib/walletOutcome'
import type { Route, Surface } from '../routing/routes'
import {
  shouldApplySwapQuoteRefresh,
  swapConfirmBlocked,
  swapQuoteMatchesDraft,
  swapQuoteRefreshAction,
  swapQuoteRefreshWaitMs,
} from './swapQuoteRefresh'
import type { SwapDraft, SwapQuoteVm, SwapTokenVm } from './swapVm'
import { swapQuotePayloadToVm } from './swapVm'

export type SwapConfirmStep = 'confirm' | 'success' | 'failure'

/**
 * State machine behind the swap confirm screen: quote refresh near expiry, fee prepare (with
 * one-time rule setup when the build reports missing rules), the reviewed prepare that Confirm
 * signs, and the submit lock that stops a refresh from replacing the quote mid-signing.
 */
export function useSwapConfirmQuote(args: {
  route: Route | string
  surface: Surface
  activeAccount: StoredAccount | undefined
  draft: SwapDraft | null
  step: SwapConfirmStep
  busy: boolean
  resolveSwapToken: (id: string) => SwapTokenVm | undefined
  priceUsdBySymbol: Record<string, number>
}) {
  const { route, surface, activeAccount, draft, step, busy, resolveSwapToken, priceUsdBySymbol } =
    args

  const [quote, setQuote] = useState<SwapQuoteVm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [prepareNonce, setPrepareNonce] = useState(0)
  /** The fee and age of the prepare the confirm screen is showing (the background holds the prepare). */
  const [reviewed, setReviewed] = useState<ReviewedFee | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  /** Last time this confirm visit fetched each quote expiry. */
  const attemptedAtRef = useRef<Map<number, number>>(new Map())
  const entryExpiresRef = useRef<number | null>(null)
  /** Bumped when a refresh starts or this confirm visit ends, so a late response is dropped. */
  const genRef = useRef(0)
  /** Set when Confirm must load a quote for the amount on screen before it can sign. */
  const forceRefreshRef = useRef(false)
  /** True from the moment Confirm starts signing until that attempt settles. */
  const submitLockRef = useRef(false)

  const refreshQuoteForConfirm = useCallback(async (): Promise<SwapQuoteVm> => {
    if (!activeAccount?.id || !draft || !quote) {
      throw new Error('Swap session expired')
    }
    const payToken = resolveSwapToken(draft.payTokenId)
    const receiveToken = resolveSwapToken(draft.receiveTokenId)
    if (!payToken || !receiveToken) throw new Error('Unknown swap token')

    const res = await sendToBackground<GetSwapQuoteRequest, GetSwapQuoteResponse>({
      type: 'GET_SWAP_QUOTE',
      payload: {
        accountId: activeAccount.id,
        assetInId: payToken.id,
        assetOutId: receiveToken.id,
        amountIn: draft.payAmount,
        slippageBps: quote.quotePayload.slippageBps,
        providerId: quote.quotePayload.providerId,
      },
    })
    if (!res.ok || !res.data) throw new Error(friendlyError(res.error) || 'Swap failed.')

    const payUsd = priceUsdBySymbol[payToken.symbol.toUpperCase()]
    const receiveUsd = priceUsdBySymbol[receiveToken.symbol.toUpperCase()]
    return swapQuotePayloadToVm(res.data.quote, payUsd, receiveUsd)
  }, [activeAccount?.id, resolveSwapToken, draft, quote, priceUsdBySymbol])

  const quotePayloadForFee = quote?.quotePayload
  const quoteExpiresAt = quotePayloadForFee?.expiresAtMs
  const onConfirmScreen = route === 'swapConfirm' && step === 'confirm'
  const refreshInput =
    onConfirmScreen && quoteExpiresAt != null && quotePayloadForFee
      ? {
          now: Date.now(),
          expiresAt: quoteExpiresAt,
          providerId: quotePayloadForFee.providerId,
          entryExpiresAt: entryExpiresRef.current,
          attemptedAt: attemptedAtRef.current.get(quoteExpiresAt) ?? null,
        }
      : null
  const quoteNeedsRefresh =
    refreshInput != null &&
    (forceRefreshRef.current || swapQuoteRefreshAction(refreshInput) === 'refresh')
  const quoteRemainingMs =
    quoteExpiresAt == null ? Number.POSITIVE_INFINITY : quoteExpiresAt - Date.now()
  const refreshQuoteRef = useRef(refreshQuoteForConfirm)
  refreshQuoteRef.current = refreshQuoteForConfirm

  useEffect(() => {
    if (!onConfirmScreen) {
      entryExpiresRef.current = null
      attemptedAtRef.current.clear()
      forceRefreshRef.current = false
      genRef.current += 1
      return
    }
    if (busy) return
    if (!quoteNeedsRefresh || quoteExpiresAt == null || refreshInput == null) {
      const wait = refreshInput ? swapQuoteRefreshWaitMs(refreshInput) : null
      if (wait != null) {
        const id = window.setTimeout(() => setRefreshTick((n) => n + 1), wait)
        return () => window.clearTimeout(id)
      }
      return
    }
    const gen = ++genRef.current
    if (entryExpiresRef.current == null) entryExpiresRef.current = quoteExpiresAt
    setLoading(true)
    setReviewed(null)
    void refreshQuoteRef
      .current()
      .then((vm) => {
        if (
          !shouldApplySwapQuoteRefresh({
            requestGen: gen,
            currentGen: genRef.current,
            submitting: submitLockRef.current,
          })
        ) {
          return
        }
        forceRefreshRef.current = false
        attemptedAtRef.current.set(quoteExpiresAt, Date.now())
        setQuote(vm)
      })
      .catch((e) => {
        if (
          !shouldApplySwapQuoteRefresh({
            requestGen: gen,
            currentGen: genRef.current,
            submitting: submitLockRef.current,
          })
        ) {
          return
        }
        forceRefreshRef.current = false
        attemptedAtRef.current.set(quoteExpiresAt, Date.now())
        setLoading(false)
        setError(e instanceof Error ? e.message : String(e))
        logLatchError('swap:quote-refresh', e)
      })
    return () => {
      genRef.current += 1
    }
  }, [onConfirmScreen, busy, quoteNeedsRefresh, quoteExpiresAt, refreshTick])

  useEffect(() => {
    if (
      route !== 'swapConfirm' ||
      step !== 'confirm' ||
      !activeAccount?.id ||
      !quotePayloadForFee ||
      quoteNeedsRefresh
    ) {
      return
    }
    const preparedExpiresAt = quotePayloadForFee.expiresAtMs
    const account = activeAccount
    let cancelled = false
    setLoading(true)
    setError(null)
    setReviewed(null)

    const prepareOnce = async () => {
      const startedAt = Date.now()
      const res = await sendToBackground<PrepareSwapTxRequest, PrepareSwapTxResponse>({
        type: 'PREPARE_SWAP_TX',
        payload: { accountId: account.id, quote: quotePayloadForFee },
      })
      return { res, startedAt }
    }

    /** One-time swap-rule setup. Settles the pending outcome so a dead popup reopens here. */
    const runSetup = async (): Promise<
      { ok: true; result: 'configured' | 'already_configured' } | { ok: false; message: string }
    > => {
      const outcomePayload = { draft, quote }
      try {
        if (surface === 'popup') {
          await writePendingWalletOutcome({
            kind: 'swap',
            status: 'in_progress',
            payload: outcomePayload,
          })
        }
        const setup = await sendToBackground<
          BackgroundRequestPayloadByType['RUN_SWAP_RULES_SETUP'],
          BackgroundResponseDataByType['RUN_SWAP_RULES_SETUP']
        >({
          type: 'RUN_SWAP_RULES_SETUP',
          payload: { accountId: account.id, quote: quotePayloadForFee, surface, outcomePayload },
        })
        if (setup.ok && setup.data) return { ok: true, result: setup.data.result }
        return { ok: false, message: friendlyError(setup.error) || 'Wallet setup failed.' }
      } catch (e) {
        logLatchError('swap:setup-rules', e)
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      } finally {
        if (surface === 'popup') await clearPendingWalletOutcome().catch(() => undefined)
      }
    }

    const needsSetup = (res: Awaited<ReturnType<typeof prepareOnce>>['res']): boolean => {
      if (res.ok && res.data) return swapBuildNeedsSignerReconfigure(res.data, account)
      return (
        isNoContextRuleError(res.error) ||
        isSwapRuleReconfigureError(res.error) ||
        (quotePayloadForFee.providerId === 'soroswap' && isPrepareSignMissingSetupError(res.error))
      )
    }

    void (async () => {
      let attempt = await prepareOnce()
      // Set up only when this build reports missing rules, then show the rebuilt fee.
      if (needsSetup(attempt.res)) {
        const setup = await runSetup()
        if (cancelled) return
        if (!setup.ok) {
          setLoading(false)
          setError(setup.message)
          return
        }
        // `already_configured`: the failure was not about setup, so keep it rather than re-prepare.
        if (setup.result === 'configured') attempt = await prepareOnce()
      }
      if (cancelled) return
      const { res, startedAt } = attempt
      setLoading(false)
      if (res.ok && res.data) {
        // Still the bundler-only auth path after setup: Confirm would only be refused, forever.
        if (swapBuildNeedsSignerReconfigure(res.data, account)) {
          setError('Swap setup did not complete. Try again.')
          return
        }
        setReviewed({ networkFee: res.data.networkFee ?? null, builtAt: startedAt })
        setNotice(null)
        const line = formatPreparedNetworkFeeLine(res.data)
        if (line) {
          setQuote((prev) =>
            prev && prev.quotePayload.expiresAtMs === preparedExpiresAt
              ? { ...prev, networkFeeLine: line }
              : prev
          )
        }
        return
      }
      if (isUserPaidFeeErrorCode(res.error?.code)) {
        setError(friendlyError(res.error))
      }
    })().catch((e) => {
      if (cancelled) return
      setLoading(false)
      logLatchError('swap:prepare-fee', e)
    })
    return () => {
      cancelled = true
    }
  }, [route, step, activeAccount?.id, quotePayloadForFee, quoteNeedsRefresh, prepareNonce])

  /** Show `message`, drop the reviewed prepare, and load a fresh quote before Confirm can sign. */
  const refuseStaleQuote = useCallback((message: string) => {
    setNotice(message)
    setReviewed(null)
    forceRefreshRef.current = true
    setRefreshTick((n) => n + 1)
  }, [])

  /** Nothing was signed (fee changed or build expired): show the message and prepare again. */
  const reviewAgain = useCallback((message: string) => {
    setNotice(message)
    setReviewed(null)
    setPrepareNonce((n) => n + 1)
  }, [])

  /**
   * Guards run when Confirm is pressed. False means nothing may be signed from this click: the
   * reason is already on screen and a fresh quote / prepare is loading.
   */
  const checkBeforeConfirm = useCallback((): boolean => {
    if (!quote || !draft) return false
    if (loading || quoteNeedsRefresh || quoteRemainingMs <= 0) {
      if (quoteRemainingMs <= 0) {
        refuseStaleQuote('This quote expired. Review the updated price and fee.')
      }
      return false
    }
    if (
      !swapQuoteMatchesDraft(
        draft.payAmount,
        quote.quotePayload.assetIn.decimals,
        quote.quotePayload.amountInRaw
      )
    ) {
      refuseStaleQuote(
        "The quote doesn't match the amount on screen. Review the updated price and fee."
      )
      return false
    }
    if (reviewed && !reviewedBuildStillValid(reviewed)) {
      // Only the fee quote is old: prepare again, the quote itself is still good.
      reviewAgain('This fee quote expired. Review the updated fee.')
      return false
    }
    return true
  }, [
    quote,
    draft,
    loading,
    quoteNeedsRefresh,
    quoteRemainingMs,
    reviewed,
    refuseStaleQuote,
    reviewAgain,
  ])

  const beginSubmit = useCallback(() => {
    genRef.current += 1
    submitLockRef.current = true
  }, [])

  const endSubmit = useCallback(() => {
    submitLockRef.current = false
  }, [])

  /** A Confirm is already signing: a second click must not start another attempt. */
  const isSubmitting = useCallback(() => submitLockRef.current, [])

  const reset = useCallback(() => {
    setQuote(null)
    setError(null)
    setNotice(null)
    setLoading(false)
    setReviewed(null)
    setPrepareNonce(0)
    attemptedAtRef.current.clear()
    entryExpiresRef.current = null
    forceRefreshRef.current = false
    submitLockRef.current = false
    genRef.current += 1
  }, [])

  const shownNetworkFee: NetworkFee | null = reviewed?.networkFee ?? null

  return {
    quote,
    setQuote,
    reviewed,
    shownNetworkFee,
    loading,
    error,
    notice,
    setNotice,
    confirmBlocked: swapConfirmBlocked({
      remainingMs: quoteRemainingMs,
      refreshing: quoteNeedsRefresh,
      feeLoading: loading,
      feeError: error != null,
    }),
    checkBeforeConfirm,
    reviewAgain,
    beginSubmit,
    endSubmit,
    isSubmitting,
    reset,
  }
}
