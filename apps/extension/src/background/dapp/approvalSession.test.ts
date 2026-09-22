import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { markDappOriginDisconnected, clearDappOriginDisconnected } from '../storage'
import {
  closeApprovalWindowForOrigin,
  isGrantAccessSuppressed,
  openApprovalPopup,
  requireDappApproval,
  resetDappApprovalSessionForTests,
  resolveDappRequestDecision,
  suppressGrantAccessPrompt,
  pendingDappResolvers,
} from './approvalSession'

function failOpenPopup() {
  vi.spyOn(chrome.action, 'openPopup').mockRejectedValue(new Error('no user gesture'))
}

describe('dapp approvalSession surface', () => {
  beforeEach(async () => {
    await resetDappApprovalSessionForTests()
  })

  afterEach(async () => {
    await resetDappApprovalSessionForTests()
    await clearDappOriginDisconnected('https://a.example')
    vi.restoreAllMocks()
  })

  it('prefers chrome.action.openPopup and does not create a durable window', async () => {
    const openSpy = vi.spyOn(chrome.action, 'openPopup').mockResolvedValue(undefined as never)
    const createSpy = vi.spyOn(chrome.windows, 'create')

    await openApprovalPopup('https://a.example')

    expect(openSpy).toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('falls back to a 360×600 durable window when openPopup fails', async () => {
    failOpenPopup()
    const createSpy = vi.spyOn(chrome.windows, 'create')

    await openApprovalPopup('https://a.example')

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({
      type: 'popup',
      width: 360,
      height: 600,
      focused: true,
    })
  })

  it('reuses an existing durable window for the same origin instead of spawning another', async () => {
    failOpenPopup()
    const createSpy = vi.spyOn(chrome.windows, 'create')
    const updateSpy = vi.spyOn(chrome.windows, 'update')

    await openApprovalPopup('https://a.example')
    await openApprovalPopup('https://a.example')

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('closeApprovalWindowForOrigin removes the tracked durable window', async () => {
    failOpenPopup()
    const removeSpy = vi.spyOn(chrome.windows, 'remove')

    await openApprovalPopup('https://a.example')
    await closeApprovalWindowForOrigin('https://a.example')

    expect(removeSpy).toHaveBeenCalledWith(99)
  })

  it('coalesces concurrent getPublicKey approvals for the same origin', async () => {
    failOpenPopup()
    const createSpy = vi.spyOn(chrome.windows, 'create')

    const first = requireDappApproval({ origin: 'https://a.example', kind: 'getPublicKey' })
    const second = requireDappApproval({ origin: 'https://a.example', kind: 'getPublicKey' })

    await vi.waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1)
    })
    expect(pendingDappResolvers.size).toBe(1)

    const requestId = [...pendingDappResolvers.keys()][0]
    expect(requestId).toBeTruthy()
    await resolveDappRequestDecision({ requestId: requestId!, approved: true })

    await expect(first).resolves.toEqual({ approved: true })
    await expect(second).resolves.toEqual({ approved: true })
  })

  it('refuses to open Grant Access while the origin is in cooldown', async () => {
    suppressGrantAccessPrompt('https://a.example', 5_000)

    await expect(
      requireDappApproval({ origin: 'https://a.example', kind: 'getPublicKey' })
    ).rejects.toThrow(/not connected/i)
  })

  it('sticky disconnect blocks Grant Access well past the dismissal cooldown', async () => {
    vi.useFakeTimers()
    failOpenPopup()
    const openSpy = vi.spyOn(chrome.action, 'openPopup')
    const createSpy = vi.spyOn(chrome.windows, 'create')

    await markDappOriginDisconnected('https://a.example')

    await expect(
      requireDappApproval({ origin: 'https://a.example', kind: 'getPublicKey' })
    ).rejects.toThrow(/not connected/i)

    // Advance past the old 2.5s cooldown — sticky flag must still block.
    vi.advanceTimersByTime(10_000)

    await expect(
      requireDappApproval({ origin: 'https://a.example', kind: 'getPublicKey' })
    ).rejects.toThrow(/not connected/i)

    expect(openSpy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('isGrantAccessSuppressed expires after the cooldown', () => {
    vi.useFakeTimers()
    suppressGrantAccessPrompt('https://a.example', 1_000)
    expect(isGrantAccessSuppressed('https://a.example')).toBe(true)
    vi.advanceTimersByTime(1_001)
    expect(isGrantAccessSuppressed('https://a.example')).toBe(false)
    vi.useRealTimers()
  })
})
