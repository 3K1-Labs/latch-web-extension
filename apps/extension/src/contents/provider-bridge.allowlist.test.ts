import { describe, expect, it, vi } from 'vitest'

import { handleProviderBridgeRequest } from './providerBridgeRequest'

describe('handleProviderBridgeRequest allowlist', () => {
  it('forwards allowlisted method as mapped MessageType with pinned origin', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: { publicKey: 'CABC' } })

    const res = await handleProviderBridgeRequest(
      {
        messageId: 1,
        method: 'getPublicKey',
        payload: { origin: 'https://evil.example' },
      },
      { pageOrigin: 'https://honest.example', sendMessage }
    )

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'DAPP_GET_PUBLIC_KEY',
      payload: { origin: 'https://honest.example' },
    })
    expect(res).toEqual({ ok: true, data: { publicKey: 'CABC' } })
  })

  it('forwards disconnect with pinned origin', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: undefined })

    await handleProviderBridgeRequest(
      {
        messageId: 2,
        method: 'disconnect',
        payload: { origin: 'https://spoof.example' },
      },
      { pageOrigin: 'https://app.example', sendMessage }
    )

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'DAPP_DISCONNECT',
      payload: { origin: 'https://app.example' },
    })
  })

  it('never calls sendMessage for internal type LOGOUT without a public method', async () => {
    const sendMessage = vi.fn()

    const res = await handleProviderBridgeRequest(
      {
        messageId: 3,
        type: 'LOGOUT',
        payload: {},
      },
      { pageOrigin: 'https://evil.example', sendMessage }
    )

    expect(sendMessage).not.toHaveBeenCalled()
    expect(res).toEqual({
      ok: false,
      error: { message: 'Unsupported provider method', code: 'unsupported_method' },
    })
  })

  it('rejects page-supplied MessageType even when type looks like a dapp message', async () => {
    const sendMessage = vi.fn()

    const res = await handleProviderBridgeRequest(
      {
        messageId: 4,
        type: 'DAPP_GET_PUBLIC_KEY',
        payload: { origin: 'https://evil.example' },
      },
      { pageOrigin: 'https://evil.example', sendMessage }
    )

    expect(sendMessage).not.toHaveBeenCalled()
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('unsupported_method')
  })

  it('rejects SET_DAPP_PERMISSIONS and RESOLVE_PENDING_DAPP_REQUEST', async () => {
    const sendMessage = vi.fn()

    for (const type of ['SET_DAPP_PERMISSIONS', 'RESOLVE_PENDING_DAPP_REQUEST']) {
      const res = await handleProviderBridgeRequest(
        { messageId: 5, type, payload: {} },
        { pageOrigin: 'https://evil.example', sendMessage }
      )
      expect(res.error?.code).toBe('unsupported_method')
    }
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('maps openSignRequest and pins nested request.origin', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true })
    const smart = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

    await handleProviderBridgeRequest(
      {
        messageId: 6,
        method: 'openSignRequest',
        payload: {
          origin: 'https://evil.example',
          request: {
            origin: 'https://evil.example',
            network: 'testnet',
            smartAccountAddress: smart,
            unsignedTxXdr: 'AAAA',
            callback: 'https://app.example/cb',
            requestId: 'rid-1',
          },
        },
      },
      { pageOrigin: 'https://app.example', sendMessage }
    )

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'DAPP_OPEN_SIGN_REQUEST',
      payload: {
        origin: 'https://app.example',
        request: {
          origin: 'https://app.example',
          network: 'testnet',
          smartAccountAddress: smart,
          unsignedTxXdr: 'AAAA',
          callback: 'https://app.example/cb',
          requestId: 'rid-1',
        },
      },
    })
  })

  it('rejects malformed signTransaction without calling sendMessage', async () => {
    const sendMessage = vi.fn()

    const res = await handleProviderBridgeRequest(
      {
        messageId: 7,
        method: 'signTransaction',
        payload: {
          origin: 'https://app.example',
          request: { xdr: 'AAAA', network: 'devnet', accountToSign: 'CABC' },
        },
      },
      { pageOrigin: 'https://app.example', sendMessage }
    )

    expect(sendMessage).not.toHaveBeenCalled()
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('validation_error')
  })
})
