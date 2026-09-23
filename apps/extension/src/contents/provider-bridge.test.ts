import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installFakePageWindow, type FakePageWindow } from '../test/fakePageWindow'

const ORIGIN = 'https://dapp.example'
const SMART = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

type RuntimeListener = (message: unknown) => void

describe('provider-bridge', () => {
  let win: FakePageWindow
  let sendMessage: ReturnType<typeof vi.fn>
  let runtimeListener: RuntimeListener | undefined

  beforeEach(async () => {
    win = installFakePageWindow(ORIGIN)
    runtimeListener = undefined

    const originalAdd = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage)
    chrome.runtime.onMessage.addListener = ((cb: RuntimeListener) => {
      runtimeListener = cb
      return originalAdd(cb as never)
    }) as typeof chrome.runtime.onMessage.addListener

    vi.resetModules()
    await import('./provider-bridge')

    sendMessage = vi.fn()
    chrome.runtime.sendMessage = sendMessage as typeof chrome.runtime.sendMessage
  })

  it('forwards getPublicKey with pinned page origin and posts response', async () => {
    sendMessage.mockResolvedValue({ ok: true, data: { publicKey: SMART } })

    win.postMessage(
      {
        source: 'LATCH_PROVIDER_REQUEST',
        messageId: 42,
        method: 'getPublicKey',
        payload: { origin: 'https://evil.example' },
      },
      ORIGIN
    )

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'DAPP_GET_PUBLIC_KEY',
        payload: { origin: ORIGIN },
      })
    })

    await vi.waitFor(() => {
      expect(
        win.__posted.some(
          (p) => (p.data as { source?: string }).source === 'LATCH_PROVIDER_RESPONSE'
        )
      ).toBe(true)
    })

    const response = win.__posted
      .map((p) => p.data as Record<string, unknown>)
      .find((d) => d.source === 'LATCH_PROVIDER_RESPONSE')

    expect(response).toEqual({
      source: 'LATCH_PROVIDER_RESPONSE',
      messageId: 42,
      ok: true,
      data: { publicKey: SMART },
      error: undefined,
    })
  })

  it('forwards signTransaction with pinned origin and returns response envelope', async () => {
    const response = { signedTxXdr: 'SIGNED' }
    sendMessage.mockResolvedValue({ ok: true, data: { response } })

    const request = {
      xdr: 'AAAAAgAAAAA=',
      network: 'testnet',
      accountToSign: SMART,
      submit: false,
    }

    win.postMessage(
      {
        source: 'LATCH_PROVIDER_REQUEST',
        messageId: 7,
        method: 'signTransaction',
        payload: {
          origin: 'https://evil.example',
          request,
        },
      },
      ORIGIN
    )

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'DAPP_SIGN_TRANSACTION',
        payload: {
          origin: ORIGIN,
          request,
        },
      })
    })

    await vi.waitFor(() => {
      const reply = win.__posted
        .map((p) => p.data as Record<string, unknown>)
        .find((d) => d.source === 'LATCH_PROVIDER_RESPONSE' && d.messageId === 7)
      expect(reply).toEqual({
        source: 'LATCH_PROVIDER_RESPONSE',
        messageId: 7,
        ok: true,
        data: { response },
        error: undefined,
      })
    })
  })

  it('rejects LOGOUT without calling sendMessage', async () => {
    win.postMessage(
      {
        source: 'LATCH_PROVIDER_REQUEST',
        messageId: 3,
        type: 'LOGOUT',
        payload: {},
      },
      ORIGIN
    )

    await vi.waitFor(() => {
      const reply = win.__posted
        .map((p) => p.data as Record<string, unknown>)
        .find((d) => d.source === 'LATCH_PROVIDER_RESPONSE' && d.messageId === 3)
      expect(reply).toMatchObject({
        ok: false,
        error: { message: 'Unsupported provider method', code: 'unsupported_method' },
      })
    })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('posts extension_unreachable when sendMessage throws', async () => {
    sendMessage.mockRejectedValue(new Error('Extension context invalidated'))

    win.postMessage(
      {
        source: 'LATCH_PROVIDER_REQUEST',
        messageId: 9,
        method: 'ping',
        payload: {},
      },
      ORIGIN
    )

    await vi.waitFor(() => {
      const reply = win.__posted
        .map((p) => p.data as Record<string, unknown>)
        .find((d) => d.source === 'LATCH_PROVIDER_RESPONSE' && d.messageId === 9)
      expect(reply).toMatchObject({
        ok: false,
        error: { message: 'Extension context invalidated', code: 'extension_unreachable' },
      })
    })
  })

  it('ignores messages whose source is not this window', async () => {
    const before = win.__posted.length
    win.dispatchFrom(
      { other: true },
      {
        source: 'LATCH_PROVIDER_REQUEST',
        messageId: 1,
        method: 'ping',
        payload: {},
      }
    )
    expect(sendMessage).not.toHaveBeenCalled()
    expect(win.__posted.length).toBe(before)
  })

  it('forwards accountChanged and networkChanged runtime events to the page', () => {
    expect(runtimeListener).toBeTypeOf('function')

    runtimeListener?.({
      type: 'LATCH_PROVIDER_EVENT',
      event: 'accountChanged',
      data: { publicKey: SMART, network: 'testnet' },
    })
    runtimeListener?.({
      type: 'LATCH_PROVIDER_EVENT',
      event: 'networkChanged',
      data: { publicKey: SMART, network: 'mainnet' },
    })
    runtimeListener?.({
      type: 'LATCH_PROVIDER_EVENT',
      event: 'somethingElse',
      data: { publicKey: SMART, network: 'testnet' },
    })

    const events = win.__posted
      .filter((p) => (p.data as { source?: string }).source === 'LATCH_PROVIDER_EVENT')
      .map((p) => p.data)

    expect(events).toEqual([
      {
        source: 'LATCH_PROVIDER_EVENT',
        event: 'accountChanged',
        data: { publicKey: SMART, network: 'testnet' },
      },
      {
        source: 'LATCH_PROVIDER_EVENT',
        event: 'networkChanged',
        data: { publicKey: SMART, network: 'mainnet' },
      },
    ])
    expect(
      win.__posted.every((p) => p.targetOrigin === ORIGIN || p.targetOrigin === undefined)
    ).toBe(true)
  })

  it('emits accountChanged from storage when active account changes', async () => {
    sendMessage.mockImplementation(async (message: { type?: string }) => {
      if (message.type === 'GET_ACTIVE_NETWORK') {
        return { ok: true, data: { network: 'mainnet' } }
      }
      return { ok: false, error: { message: 'unexpected' } }
    })

    await chrome.storage.local.set({
      'latch.accounts': [{ id: 'acct-1', smartAccountAddress: SMART }],
      'latch.activeAccountId': 'acct-1',
    })

    await vi.waitFor(() => {
      const event = win.__posted
        .map((p) => p.data as Record<string, unknown>)
        .find((d) => d.source === 'LATCH_PROVIDER_EVENT' && d.event === 'accountChanged')
      expect(event).toEqual({
        source: 'LATCH_PROVIDER_EVENT',
        event: 'accountChanged',
        data: { publicKey: SMART, network: 'mainnet' },
      })
    })
  })

  it('does not emit accountChanged when storage has no public key', async () => {
    const before = win.__posted.filter(
      (p) => (p.data as { source?: string }).source === 'LATCH_PROVIDER_EVENT'
    ).length

    await chrome.storage.local.set({
      'latch.accounts': [{ id: 'acct-1' }],
      'latch.activeAccountId': 'acct-1',
    })

    // Allow async emitActiveAccountFromStorage to settle.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const after = win.__posted.filter(
      (p) => (p.data as { source?: string }).source === 'LATCH_PROVIDER_EVENT'
    ).length
    expect(after).toBe(before)
  })
})
