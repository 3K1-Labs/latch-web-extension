import type { NetworkFee } from '@latch/types'

/**
 * How long a reviewed build is signed as-is. Auth entries are valid for about 120 ledgers
 * (~10 minutes) and no ledger source is available on the signing path, so age is the proxy:
 * stay well inside that window.
 */
export const REVIEWED_BUILD_TTL_MS = 8 * 60 * 1000

export function reviewedBuildStillValid(
  reviewed: { builtAt: number } | null | undefined,
  now = Date.now()
): boolean {
  if (!reviewed) return false
  const age = now - reviewed.builtAt
  return age >= 0 && age <= REVIEWED_BUILD_TTL_MS
}

/**
 * What the UI keeps of a build the user reviewed: the fee on screen and how old the build is.
 * The build itself stays in the background, which signs it; the UI never holds tx bytes to sign.
 */
export type ReviewedFee = { networkFee: NetworkFee | null; builtAt: number }
