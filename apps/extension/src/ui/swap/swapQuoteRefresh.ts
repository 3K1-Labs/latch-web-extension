import { humanToRaw } from '@latch/swap'

/**
 * How long to wait before asking for the same quote expiry again.
 * Just above the background quote cache (`QUOTE_DEDUPE_TTL_MS` in quoteCache.ts, 15s)
 * so a cache hit cannot start another request immediately.
 */
export const QUOTE_CACHE_DEDUPE_MS = 16_000

/** Refresh a quote this long before it expires. */
export const QUOTE_REFRESH_LEAD_MS = 5_000

export type SwapQuoteRefreshInput = {
  now: number
  expiresAt: number
  providerId: string
  /** Expiry of the quote that was on screen when this confirm visit started refreshing. */
  entryExpiresAt: number | null
  /** When this expiry was last fetched on this confirm visit, if ever. */
  attemptedAt: number | null
}

/** Fetch a new quote, or wait until the lead window or the cache dedupe elapses. */
export function swapQuoteRefreshAction(input: SwapQuoteRefreshInput): 'refresh' | 'wait' {
  const remaining = input.expiresAt - input.now
  const attemptedRecently =
    input.attemptedAt != null && input.now - input.attemptedAt < QUOTE_CACHE_DEDUPE_MS
  const dueToClock = remaining <= QUOTE_REFRESH_LEAD_MS
  const dueToEntry =
    input.providerId === 'soroswap' &&
    (input.entryExpiresAt == null || input.entryExpiresAt === input.expiresAt)
  if ((dueToClock || dueToEntry) && !attemptedRecently) return 'refresh'
  return 'wait'
}

/** Ms until the confirm screen should re-check the quote, or null when nothing is pending. */
export function swapQuoteRefreshWaitMs(input: SwapQuoteRefreshInput): number | null {
  if (swapQuoteRefreshAction(input) === 'refresh') return null
  const remaining = input.expiresAt - input.now
  const untilLead = remaining - QUOTE_REFRESH_LEAD_MS
  const untilExpiry = remaining
  const untilRetry =
    input.attemptedAt == null ? null : input.attemptedAt + QUOTE_CACHE_DEDUPE_MS - input.now
  const candidates = [untilLead, untilExpiry, untilRetry].filter(
    (ms): ms is number => ms != null && ms > 0
  )
  if (candidates.length === 0) return null
  return Math.min(...candidates)
}

/** Apply a confirm-screen refresh only if that request is still current and submit has not started. */
export function shouldApplySwapQuoteRefresh(input: {
  requestGen: number
  currentGen: number
  submitting: boolean
}): boolean {
  return input.requestGen === input.currentGen && !input.submitting
}

/** True when the amount on screen is the amount this quote would sign. */
export function swapQuoteMatchesDraft(
  payAmount: string,
  decimals: number,
  amountInRaw: string
): boolean {
  try {
    return humanToRaw(payAmount, decimals) === amountInRaw
  } catch {
    return false
  }
}

/** Confirm must stay disabled while a refresh, fee prepare, fee error, or an expired quote is in progress. */
export function swapConfirmBlocked(input: {
  remainingMs: number
  refreshing: boolean
  feeLoading: boolean
  feeError: boolean
}): boolean {
  return input.refreshing || input.feeLoading || input.feeError || input.remainingMs <= 0
}
