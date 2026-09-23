import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DAPP_REQUEST_TTL_MS,
  DAPP_REQUESTS_SESSION_KEY,
  LEGACY_PENDING_DAPP_REQUESTS_LOCAL_KEY,
  expireStaleDappRequests,
  getDappRequest,
  listLiveDappRequests,
  resolveDappRequest,
  resetDappRequestStateForTests,
  upsertDappRequest,
  clearAllDappRequests,
} from './requestState'

describe('dapp requestState', () => {
  beforeEach(async () => {
    resetDappRequestStateForTests()
    await clearAllDappRequests()
    await chrome.storage.local.remove([LEGACY_PENDING_DAPP_REQUESTS_LOCAL_KEY])
  })

  it('persists awaiting requests in session storage', async () => {
    await upsertDappRequest({
      id: 'r1',
      origin: 'https://a.example',
      kind: 'getPublicKey',
      createdAt: Date.now(),
    })

    const bag = await chrome.storage.session.get(DAPP_REQUESTS_SESSION_KEY)
    expect(bag[DAPP_REQUESTS_SESSION_KEY]).toMatchObject({
      r1: expect.objectContaining({ status: 'awaiting_user' }),
    })
    expect(await listLiveDappRequests()).toHaveLength(1)
  })

  it('clears legacy local pending key on first read', async () => {
    resetDappRequestStateForTests()
    await chrome.storage.local.set({
      [LEGACY_PENDING_DAPP_REQUESTS_LOCAL_KEY]: [
        { id: 'legacy', origin: 'https://a.example', kind: 'getPublicKey', createdAt: 1 },
      ],
    })

    await listLiveDappRequests()

    const bag = await chrome.storage.local.get(LEGACY_PENDING_DAPP_REQUESTS_LOCAL_KEY)
    expect(bag[LEGACY_PENDING_DAPP_REQUESTS_LOCAL_KEY]).toBeUndefined()
  })

  it('resolve is idempotent once terminal', async () => {
    await upsertDappRequest({
      id: 'r2',
      origin: 'https://a.example',
      kind: 'getPublicKey',
      createdAt: Date.now(),
    })

    const first = await resolveDappRequest({ requestId: 'r2', approved: true })
    expect(first.changed).toBe(true)
    expect(first.record?.status).toBe('approved')

    const second = await resolveDappRequest({
      requestId: 'r2',
      approved: false,
      errorCode: 'user_rejected',
    })
    expect(second.changed).toBe(false)
    expect(second.record?.status).toBe('approved')
  })

  it('expires stale live requests', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    await upsertDappRequest({
      id: 'r3',
      origin: 'https://a.example',
      kind: 'getPublicKey',
      createdAt: now,
    })

    vi.setSystemTime(now + DAPP_REQUEST_TTL_MS + 1)
    await expireStaleDappRequests()

    const row = await getDappRequest('r3')
    expect(row?.status).toBe('expired')
    expect(await listLiveDappRequests()).toEqual([])

    vi.useRealTimers()
  })
})
