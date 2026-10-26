import { beforeEach, describe, expect, it } from 'vitest'

import { createChromeMock } from '../../test/chromeMock'
import { REVIEWED_BUILD_TTL_MS } from '../../ui/lib/reviewedBuild'
import {
  REVIEWED_BUILDS_KEY,
  reviewedBuildKey,
  saveReviewedBuild,
  takeReviewedBuild,
} from './reviewedBuildStore'

describe('reviewedBuildStore', () => {
  beforeEach(() => {
    globalThis.chrome = createChromeMock() as unknown as typeof chrome
  })

  it('returns the build saved for the same request, once', async () => {
    await saveReviewedBuild('send', { to: 'C1', amount: '1' }, { txXdr: 'a' })
    expect(await takeReviewedBuild('send', { amount: '1', to: 'C1' })).toEqual({ txXdr: 'a' })
    expect(await takeReviewedBuild('send', { to: 'C1', amount: '1' })).toBeNull()
  })

  it('hashes equal requests equally regardless of key order or undefined fields', async () => {
    const a = await reviewedBuildKey('send', { a: 1, b: { c: 2, d: undefined } })
    const b = await reviewedBuildKey('send', { b: { c: 2 }, a: 1 })
    expect(a).toBe(b)
  })

  it('does not hand a build to a different recipient, amount, or kind', async () => {
    await saveReviewedBuild('send', { to: 'C1', amount: '1' }, { txXdr: 'a' })
    expect(await takeReviewedBuild('send', { to: 'C2', amount: '1' })).toBeNull()
    expect(await takeReviewedBuild('send', { to: 'C1', amount: '2' })).toBeNull()
    expect(await takeReviewedBuild('swap', { to: 'C1', amount: '1' })).toBeNull()
    expect(await takeReviewedBuild('send', { to: 'C1', amount: '1' })).toEqual({ txXdr: 'a' })
  })

  it('rejects an expired build', async () => {
    await saveReviewedBuild(
      'swap',
      { q: 1 },
      { txXdr: 'old' },
      Date.now() - REVIEWED_BUILD_TTL_MS - 1
    )
    expect(await takeReviewedBuild('swap', { q: 1 })).toBeNull()
  })

  it('keeps only the most recent entries', async () => {
    for (let i = 0; i < 12; i++) await saveReviewedBuild('send', { i }, { txXdr: String(i) })
    const bag = await chrome.storage.session.get(REVIEWED_BUILDS_KEY)
    expect(Object.keys(bag[REVIEWED_BUILDS_KEY])).toHaveLength(8)
    expect(await takeReviewedBuild('send', { i: 0 })).toBeNull()
    expect(await takeReviewedBuild('send', { i: 11 })).toEqual({ txXdr: '11' })
  })

  it('never touches chrome.storage.local', async () => {
    await saveReviewedBuild('send', { i: 1 }, { txXdr: 'x' })
    expect(await chrome.storage.local.get(null)).toEqual({})
  })

  it('does not throw when storage fails (the estimate must still succeed)', async () => {
    chrome.storage.session.set = (() => Promise.reject(new Error('quota'))) as never
    await expect(saveReviewedBuild('send', { i: 1 }, { txXdr: 'x' })).resolves.toBeUndefined()
  })
})
