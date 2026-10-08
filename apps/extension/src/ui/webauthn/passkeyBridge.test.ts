import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChromeMock } from '../../test/chromeMock'

const sendToBackground = vi.fn()

vi.mock('../lib/backgroundClient', () => ({
  sendToBackground: (...args: unknown[]) => sendToBackground(...args),
  friendlyError: (e?: { message?: string }) => e?.message ?? 'error',
}))

describe('passkeyBridge UI client', () => {
  beforeEach(() => {
    const mock = createChromeMock()
    globalThis.chrome = mock as unknown as typeof chrome
    sendToBackground.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('openPasskeyBridgeAndWait delegates to RUN_PASSKEY_BRIDGE', async () => {
    sendToBackground.mockResolvedValue({ ok: true, data: { id: 'cred' } })
    const { openPasskeyBridgeAndWait } = await import('./passkeyBridge')
    await expect(
      openPasskeyBridgeAndWait({
        mode: 'authentication',
        optionsJSON: { challenge: 'abc' },
      })
    ).resolves.toEqual({ id: 'cred' })
    expect(sendToBackground).toHaveBeenCalledWith(
      {
        type: 'RUN_PASSKEY_BRIDGE',
        payload: {
          mode: 'authentication',
          optionsJSON: { challenge: 'abc' },
        },
      },
      120_000
    )
  })

  it('openPasskeyBridgeAndWait throws on background error', async () => {
    sendToBackground.mockResolvedValue({
      ok: false,
      error: { message: 'Passkey was cancelled or failed.' },
    })
    const { openPasskeyBridgeAndWait } = await import('./passkeyBridge')
    await expect(
      openPasskeyBridgeAndWait({
        mode: 'registration',
        optionsJSON: { challenge: 'xyz' },
      })
    ).rejects.toThrow('Passkey was cancelled or failed.')
  })

  it('publishPasskeyBridgeResult writes session storage', async () => {
    const { publishPasskeyBridgeResult, passkeyBridgeResultStorageKey } =
      await import('./passkeyBridge')
    const ticket = 'ticket-1'
    await publishPasskeyBridgeResult({
      ticket,
      ok: true,
      response: { id: 'cred' },
    })
    const bag = await chrome.storage.session.get(passkeyBridgeResultStorageKey(ticket))
    expect(bag[passkeyBridgeResultStorageKey(ticket)]).toMatchObject({
      ok: true,
      response: { id: 'cred' },
    })
  })
})
