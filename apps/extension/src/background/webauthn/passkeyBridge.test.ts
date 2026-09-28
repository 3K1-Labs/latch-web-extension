import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChromeMock } from '../../test/chromeMock'
import { passkeyBridgeResultStorageKey, runPasskeyBridgeAndWait } from '../webauthn/passkeyBridge'

describe('background passkeyBridge', () => {
  beforeEach(() => {
    const mock = createChromeMock()
    globalThis.chrome = mock as unknown as typeof chrome
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000001' as `${string}-${string}-${string}-${string}-${string}`
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves when result is published via storage', async () => {
    const ticket = '00000000-0000-4000-8000-000000000001'
    const waiter = runPasskeyBridgeAndWait({
      mode: 'authentication',
      optionsJSON: { challenge: 'abc', rpId: 'example.com' },
      timeoutMs: 5_000,
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await chrome.storage.session.set({
      [passkeyBridgeResultStorageKey(ticket)]: {
        ok: true,
        response: { id: 'cred' },
        createdAt: Date.now(),
      },
    })

    await expect(waiter).resolves.toEqual({ id: 'cred' })
  })

  it('rejects when published failure result arrives via storage', async () => {
    const ticket = '00000000-0000-4000-8000-000000000001'
    const waiter = runPasskeyBridgeAndWait({
      mode: 'registration',
      optionsJSON: { challenge: 'xyz' },
      timeoutMs: 5_000,
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await chrome.storage.session.set({
      [passkeyBridgeResultStorageKey(ticket)]: {
        ok: false,
        error: 'User cancelled.',
        createdAt: Date.now(),
      },
    })

    await expect(waiter).rejects.toThrow('User cancelled.')
  })

  it('closes the bridge window once the ceremony settles', async () => {
    const ticket = '00000000-0000-4000-8000-000000000001'
    const removeSpy = vi.spyOn(chrome.windows, 'remove')
    const waiter = runPasskeyBridgeAndWait({
      mode: 'authentication',
      optionsJSON: { challenge: 'abc' },
      timeoutMs: 5_000,
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await chrome.storage.session.set({
      [passkeyBridgeResultStorageKey(ticket)]: {
        ok: true,
        response: { id: 'cred' },
        createdAt: Date.now(),
      },
    })

    await expect(waiter).resolves.toEqual({ id: 'cred' })
    expect(removeSpy).toHaveBeenCalledWith(99)
  })
})
