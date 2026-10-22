import type { NetworkFee } from '@latch/types'

/** "up to 0.014 XLM": the most a user-paid transaction may charge; the real fee is usually lower. */
export function formatNetworkFeeLine(fee?: NetworkFee | null): string | null {
  const amount = fee?.maxAmount?.trim()
  const symbol = fee?.symbol?.trim()
  if (!amount || !symbol) return null
  return `up to ${amount} ${symbol}`
}

const USER_PAID_FEE_ERRORS: Record<string, string> = {
  insufficient_fee_balance: 'Add XLM or USDC to pay the network fee.',
  fee_quote_stale: 'The network fee changed. Review the transaction and sign again.',
  fee_rule_not_found:
    "This signer can't authorize the network fee for this wallet. The wallet needs a setup step.",
  too_many_failed_transactions:
    'Too many recent transactions from this wallet failed. Try again later.',
  sponsorship_limit_reached: 'Free transaction limit reached. Try again later.',
  service_unavailable: 'The transaction service is temporarily unavailable. Please retry.',
}

/** User-facing copy for latch-api user-paid fee error codes, or null for other codes. */
export function userPaidFeeErrorMessage(code?: string): string | null {
  if (!code) return null
  return USER_PAID_FEE_ERRORS[code] ?? null
}

/** Fee errors that must not be retried as missing send/swap context rules. */
export function isUserPaidFeeErrorCode(code?: string): boolean {
  return userPaidFeeErrorMessage(code) !== null
}
