import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createChromeMock } from '../../test/chromeMock'
import { closeWalletSurface } from './uiSurface'

describe('closeWalletSurface', () => {
  const windowClose = vi.fn()

  beforeEach(() => {
    globalThis.chrome = createChromeMock() as typeof chrome
    windowClose.mockReset()
    vi.stubGlobal('window', { close: windowClose })
  })

  it('calls sidePanel.close for sidepanel when available', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    ;(chrome.sidePanel as { close: typeof close }).close = close
    vi.spyOn(chrome.windows, 'getCurrent').mockResolvedValue({ id: 42 } as chrome.windows.Window)

    await closeWalletSurface('sidepanel')

    expect(close).toHaveBeenCalledWith({ windowId: 42 })
    expect(windowClose).not.toHaveBeenCalled()
  })

  it('falls back to window.close for popup', async () => {
    await closeWalletSurface('popup')
    expect(windowClose).toHaveBeenCalled()
  })

  it('falls back to window.close when sidePanel.close is missing', async () => {
    delete (chrome.sidePanel as { close?: unknown }).close
    await closeWalletSurface('sidepanel')
    expect(windowClose).toHaveBeenCalled()
  })
})
