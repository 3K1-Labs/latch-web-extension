import type { SerializableError } from '@latch/types'

import { isReviewAgainCode } from './networkFee'
import { reviewedBuildStillValid } from './reviewedBuild'

/**
 * Before Confirm talks to the background: an old review is not signed, the summary re-estimates.
 * No review at all (the estimate failed for another reason) still goes through.
 */
export function gateReviewed(
  reviewed: { builtAt: number } | null,
  now = Date.now()
): 'ok' | 'expired' {
  return reviewed && !reviewedBuildStillValid(reviewed, now) ? 'expired' : 'ok'
}

/** What the summary does with the background's reply to a Confirm. */
export function classifySendResponse(res: {
  ok: boolean
  error?: SerializableError
}): 'success' | 'review_again' | 'failed' {
  if (res.ok) return 'success'
  return isReviewAgainCode(res.error?.code) ? 'review_again' : 'failed'
}
