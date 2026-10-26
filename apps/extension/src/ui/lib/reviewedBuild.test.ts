import { describe, expect, it } from 'vitest'

import { REVIEWED_BUILD_TTL_MS, reviewedBuildStillValid } from './reviewedBuild'

describe('reviewedBuildStillValid', () => {
  const now = 1_000_000_000

  it('is valid inside the window', () => {
    expect(reviewedBuildStillValid({ builtAt: now - 1_000 }, now)).toBe(true)
    expect(reviewedBuildStillValid({ builtAt: now - REVIEWED_BUILD_TTL_MS }, now)).toBe(true)
  })

  it('expires after the window', () => {
    expect(reviewedBuildStillValid({ builtAt: now - REVIEWED_BUILD_TTL_MS - 1 }, now)).toBe(false)
  })

  it('rejects a missing build or a build from the future', () => {
    expect(reviewedBuildStillValid(null, now)).toBe(false)
    expect(reviewedBuildStillValid(undefined, now)).toBe(false)
    expect(reviewedBuildStillValid({ builtAt: now + 5_000 }, now)).toBe(false)
  })
})
