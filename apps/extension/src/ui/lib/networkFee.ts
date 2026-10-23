import { humanToRaw, rawToHuman } from '@latch/swap'
import type { NetworkFee, SmartAccountBalanceRow } from '@latch/types'

const SAC_DECIMALS = 7

/** Background error code when the confirm build's fee is not the fee the user reviewed. */
export const NETWORK_FEE_CHANGED_CODE = 'network_fee_changed'
export const NETWORK_FEE_CHANGED_MESSAGE =
  'The network fee changed. Review the new fee and send again.'

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

/** Must match latch-api `internal/webappx/errors.go` (user-paid fee codes). */
export const USER_PAID_FEE_ERROR_CODES = [
  'insufficient_fee_balance',
  'fee_quote_stale',
  'too_many_failed_transactions',
  'sponsorship_limit_reached',
  'sponsorship_retry',
] as const

export type UserPaidFeeErrorCode = (typeof USER_PAID_FEE_ERROR_CODES)[number]

const USER_PAID_FEE_ERRORS: Record<UserPaidFeeErrorCode, string> = {
  insufficient_fee_balance: 'Add XLM or USDC to pay the network fee.',
  fee_quote_stale: 'The network fee changed. Review the transaction and sign again.',
  too_many_failed_transactions:
    'Too many recent transactions from this wallet failed. Try again later.',
  sponsorship_limit_reached: 'Free transaction limit reached. Try again later.',
  sponsorship_retry: "The transaction didn't go through and nothing was charged. Try again.",
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
 * Max amount from a fee probe. A user-paid fee error means the fee cannot be covered, so Max is 0.
 * Any other failure leaves the typed amount unchanged (`null`).
 */
export function maxSendAmountFromProbe(
  token: Pick<SmartAccountBalanceRow, 'sacContractId' | 'amount' | 'decimals'>,
  probe: { ok: true; networkFee?: NetworkFee | null } | { ok: false; code?: string }
): string | null {
  if (!probe.ok) return isUserPaidFeeErrorCode(probe.code) ? '0' : null
  return maxSendAmountAfterFee(token, probe.networkFee)
}
