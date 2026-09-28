import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PENDING_WALLET_OUTCOME_KEY, readPendingWalletOutcome } from '../../lib/walletOutcome'
import { createChromeMock } from '../../test/chromeMock'
import { finishOutcome } from './finishOutcome'

describe('finishOutcome', () => {
  beforeEach(() => {
    globalThis.chrome = createChromeMock() as unknown as typeof chrome
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing for the side panel', async () => {
    const openSpy = vi.spyOn(chrome.action, 'openPopup')
    const createSpy = vi.spyOn(chrome.windows, 'create')

    await finishOutcome({ surface: 'sidepanel', kind: 'send', status: 'success' })

    expect(openSpy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
    expect(await readPendingWalletOutcome()).toBeNull()
  })

  it('leaves an open toolbar popup alone', async () => {
    chrome.runtime.getContexts = vi.fn().mockResolvedValue([{ contextType: 'POPUP' }])
    const openSpy = vi.spyOn(chrome.action, 'openPopup')
    const createSpy = vi.spyOn(chrome.windows, 'create')

    await finishOutcome({ surface: 'popup', kind: 'swap', status: 'success' })

    expect(openSpy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
    expect((await readPendingWalletOutcome())?.status).toBe('success')
  })

  it('reopens the toolbar popup when it was destroyed, without opening a window', async () => {
    chrome.runtime.getContexts = vi.fn().mockResolvedValue([])
    const openSpy = vi.spyOn(chrome.action, 'openPopup')
    const createSpy = vi.spyOn(chrome.windows, 'create')

    await finishOutcome({ surface: 'popup', kind: 'send', status: 'failure', error: 'boom' })

    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('keeps the outcome and opens no window when openPopup is refused', async () => {
    chrome.runtime.getContexts = vi.fn().mockResolvedValue([])
    vi.spyOn(chrome.action, 'openPopup').mockRejectedValue(new Error('no user gesture'))
    const createSpy = vi.spyOn(chrome.windows, 'create')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await finishOutcome({ surface: 'popup', kind: 'swap', status: 'success' })

    expect(createSpy).not.toHaveBeenCalled()
    const bag = await chrome.storage.session.get(PENDING_WALLET_OUTCOME_KEY)
    expect(bag[PENDING_WALLET_OUTCOME_KEY]?.status).toBe('success')
  })
})
