import { humanToRaw, rawToHuman } from '@latch/swap'
import type { NetworkFee, SmartAccountBalanceRow } from '@latch/types'

const SAC_DECIMALS = 7

/** Background error code when the confirm build's fee is not the fee the user reviewed. */
export const NETWORK_FEE_CHANGED_CODE = 'network_fee_changed'
export const NETWORK_FEE_CHANGED_MESSAGE =
  'The network fee changed. Review the new fee and confirm again.'

/** Background error code when nothing was signed because the review is stale or setup ran. */
export const REVIEW_AGAIN_CODE = 'review_again'
export const REVIEW_OUT_OF_DATE_MESSAGE =
  'This review is out of date. Review the updated details and confirm again.'
export const REVIEW_SETUP_MESSAGE =
  'Your wallet needed a one-time setup. Review the updated fee and confirm.'

/** Any "nothing was signed, review again" refusal: a changed fee, a stale review, or setup. */
export function isReviewAgainCode(code?: string): boolean {
  return code === NETWORK_FEE_CHANGED_CODE || code === REVIEW_AGAIN_CODE
}

/** "up to 0.014 XLM": the most a user-paid transaction may charge; the real fee is usually lower. */
export function formatNetworkFeeLine(fee?: NetworkFee | null): string | null {
  const amount = fee?.maxAmount?.trim()
  const symbol = fee?.symbol?.trim()
  if (!amount || !symbol) return null
  return `up to ${amount} ${symbol}`
}

/** Prefer the signed max (`networkFee`); fall back to the older estimated-XLM fields. */
export function formatPreparedNetworkFeeLine(
  prepared?: {
    networkFee?: NetworkFee | null
    estimatedFeeXlm?: string
    feeLabel?: string
  } | null
): string | null {
  if (!prepared) return null
  const maxFee = formatNetworkFeeLine(prepared.networkFee)
  if (maxFee) return maxFee
  if (prepared.feeLabel?.trim()) return prepared.feeLabel.trim()
  const xlm = prepared.estimatedFeeXlm?.trim()
  return xlm ? `~ ${xlm} Stellar` : null
}

/** Must match latch-api `master` `internal/webappx/errors.go` (gasless and user-paid fee codes). */
export const USER_PAID_FEE_ERROR_CODES = [
  'insufficient_fee_balance',
  'fee_quote_stale',
  'fee_rule_not_found',
  'too_many_failed_transactions',
  'sponsorship_limit_reached',
  'service_unavailable',
] as const

export type UserPaidFeeErrorCode = (typeof USER_PAID_FEE_ERROR_CODES)[number]

const USER_PAID_FEE_ERRORS: Record<UserPaidFeeErrorCode, string> = {
  insufficient_fee_balance: 'Add XLM or USDC to pay the network fee.',
  fee_quote_stale: 'The network fee changed. Review the transaction and sign again.',
  too_many_failed_transactions:
    'Too many recent transactions from this wallet failed. Try again later.',
  fee_rule_not_found:
    "This signer can't authorize the network fee for this wallet. The wallet needs a setup step.",
  sponsorship_limit_reached: 'Free transaction limit reached. Try again later.',
  // latch-api sends this only from its gasless error handler: the transaction service is down or
  // hasn't confirmed the submission yet, and retrying is safe.
  service_unavailable: 'The transaction service is temporarily unavailable. Please retry.',
}

/** User-facing copy for latch-api user-paid fee error codes, or null for other codes. */
export function userPaidFeeErrorMessage(code?: string): string | null {
  if (!code || !Object.prototype.hasOwnProperty.call(USER_PAID_FEE_ERRORS, code)) return null
  return USER_PAID_FEE_ERRORS[code as UserPaidFeeErrorCode]
}

/** Fee errors that must not be retried as missing send/swap context rules. */
export function isUserPaidFeeErrorCode(code?: string): boolean {
  return userPaidFeeErrorMessage(code) !== null
}

/**
 * True when the fee about to be signed is not covered by the fee the user reviewed:
 * a fee appeared, the fee token changed, or the maximum went up. A lower maximum is fine.
 */
export function networkFeeChanged(
  shown: NetworkFee | null | undefined,
  signed: NetworkFee | null | undefined
): boolean {
  if (!signed) return false
  if (!shown) return true
  if (shown.token !== signed.token) return true
  try {
    return BigInt(signed.maxAmountRaw) > BigInt(shown.maxAmountRaw)
  } catch {
    return true
  }
}

/** The fee is charged in the token being sent, so it comes out of the same balance. */
export function isNetworkFeeToken(
  token: Pick<SmartAccountBalanceRow, 'sacContractId'>,
  fee: NetworkFee | null | undefined
): boolean {
  return Boolean(fee?.token && token.sacContractId && fee.token === token.sacContractId)
}

/**
 * Largest amount "Max" may send: the balance, less the maximum fee when the fee is paid in
 * the same token. Clamped at 0. Falls back to the full balance on unparsable input.
 */
export function maxSendAmountAfterFee(
  token: Pick<SmartAccountBalanceRow, 'sacContractId' | 'amount' | 'decimals'>,
  fee: NetworkFee | null | undefined
): string {
  if (!fee || !isNetworkFeeToken(token, fee)) return token.amount
  const decimals = token.decimals ?? SAC_DECIMALS
  try {
    const balanceRaw = BigInt(humanToRaw(token.amount, decimals))
    const remaining = balanceRaw - BigInt(fee.maxAmountRaw)
    return remaining > 0n ? rawToHuman(remaining.toString(), decimals) : '0'
  } catch {
    return token.amount
  }
}

/**
 * Max amount from a fee probe. Only `insufficient_fee_balance` means the fee cannot be covered, so
 * Max is 0. Any other failure (including transient codes such as `service_unavailable`)
 * leaves the typed amount unchanged (`null`).
 */
export function maxSendAmountFromProbe(
  token: Pick<SmartAccountBalanceRow, 'sacContractId' | 'amount' | 'decimals'>,
  probe: { ok: true; networkFee?: NetworkFee | null } | { ok: false; code?: string }
): string | null {
  if (!probe.ok) return probe.code === 'insufficient_fee_balance' ? '0' : null
  return maxSendAmountAfterFee(token, probe.networkFee)
}

/** Smallest SAC unit: builds a send only to learn its fee, never to submit. */
export const FEE_PROBE_AMOUNT = '0.0000001'

export type MaxFeeProbe =
  | { ok: true; networkFee?: NetworkFee | null }
  | { ok: false; code?: string }

/**
 * Max amount that still fits its own fee. The first probe prices a tiny send; a larger amount can
 * price higher (fresh fee stats, different simulation), so build again at the computed amount and
 * shrink until the fee on that build fits the balance. At most three probes.
 */
export async function fitMaxSendAmount(
  token: Pick<SmartAccountBalanceRow, 'sacContractId' | 'amount' | 'decimals'>,
  probeAt: (amount: string) => Promise<MaxFeeProbe>
): Promise<string | null> {
  const first = await probeAt(FEE_PROBE_AMOUNT)
  const firstAmount = maxSendAmountFromProbe(token, first)
  // Failed, nothing to spend, or the fee is paid in another token: no headroom to verify.
  if (!first.ok || firstAmount == null || firstAmount === '0' || !first.networkFee) {
    return firstAmount
  }
  if (!isNetworkFeeToken(token, first.networkFee)) return firstAmount

  let amount = firstAmount
  let fee = first.networkFee
  for (let i = 0; i < 2; i++) {
    const check = await probeAt(amount)
    if (!check.ok) {
      if (check.code !== 'insufficient_fee_balance') return amount
      // The real build prices above the probe: leave twice the first fee as headroom.
      fee = { ...fee, maxAmountRaw: (BigInt(fee.maxAmountRaw) * 2n).toString() }
      amount = maxSendAmountAfterFee(token, fee)
      if (amount === '0') return amount
      continue
    }
    const checked = check.networkFee
    if (!checked || !isNetworkFeeToken(token, checked)) return amount
    if (BigInt(checked.maxAmountRaw) <= BigInt(fee.maxAmountRaw)) return amount
    fee = checked
    amount = maxSendAmountAfterFee(token, checked)
    if (amount === '0') return amount
  }
  return amount
}

/** Same token and cap (or neither charges a user-paid fee). */
export function networkFeeEquals(
  a: NetworkFee | null | undefined,
  b: NetworkFee | null | undefined
): boolean {
  if (!a || !b) return !a && !b
  return a.token === b.token && a.maxAmountRaw === b.maxAmountRaw
}
