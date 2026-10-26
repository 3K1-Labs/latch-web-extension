import { BackendError } from '../backend'
import {
  NETWORK_FEE_CHANGED_CODE,
  NETWORK_FEE_CHANGED_MESSAGE,
  REVIEW_AGAIN_CODE,
  REVIEW_OUT_OF_DATE_MESSAGE,
  REVIEW_SETUP_MESSAGE,
  isReviewAgainCode,
} from '../../ui/lib/networkFee'

/** Why nothing was signed. */
export type ReviewAgainReason =
  /** The fee differs from the one the user reviewed. */
  | 'fee_changed'
  /** The reviewed build is missing or expired. */
  | 'out_of_date'
  /** Wallet rules were missing; they are set up on the screen the user returns to. */
  | 'setup_needed'

const BY_REASON: Record<ReviewAgainReason, { code: string; message: string }> = {
  fee_changed: { code: NETWORK_FEE_CHANGED_CODE, message: NETWORK_FEE_CHANGED_MESSAGE },
  out_of_date: { code: REVIEW_AGAIN_CODE, message: REVIEW_OUT_OF_DATE_MESSAGE },
  setup_needed: { code: REVIEW_AGAIN_CODE, message: REVIEW_SETUP_MESSAGE },
}

/** Nothing was signed: the user must review a fresh build (and its fee) and confirm again. */
export function reviewAgainError(reason: ReviewAgainReason): BackendError {
  const { code, message } = BY_REASON[reason]
  return new BackendError(message, { status: 409, code })
}

export function isReviewAgainError(e: unknown): boolean {
  return e instanceof BackendError && isReviewAgainCode(e.code)
}
