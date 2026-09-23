import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installFakePageWindow, type FakePageWindow } from '../test/fakePageWindow'

const ORIGIN = 'https://dapp.example'
const SMART = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

type LatchProvider = {
  isConnected(): Promise<boolean>
  getPublicKey(): Promise<string>
  getNetwork(): Promise<'testnet' | 'mainnet'>
  signTransaction(
    requestOrXdr:
      | { xdr: string; network: 'testnet' | 'mainnet'; accountToSign: string; submit?: boolean }
      | string,
    opts?: { networkPassphrase?: string; address?: string; submit?: boolean }
  ): Promise<unknown>
  on(event: 'accountChanged' | 'networkChanged', handler: (payload: unknown) => void): void
  off(event: 'accountChanged' | 'networkChanged', handler: (payload: unknown) => void): void
}

type BridgeRequest = {
  source: string
  messageId: number
  method?: string
  payload?: unknown
}

type Reply =
  | { ok: true; data?: unknown }
  | { ok: false; error?: { message: string; code?: string } }

function latchOf(win: FakePageWindow): LatchProvider {
  const latch = win.latch as LatchProvider | undefined
  if (!latch) throw new Error('window.latch was not installed')
  return latch
}

function onProviderRequest(
  win: FakePageWindow,
  handler: (req: BridgeRequest) => Reply | undefined
): void {
  win.addEventListener('message', (event) => {
    const data = event.data as BridgeRequest
    if (!data || data.source !== 'LATCH_PROVIDER_REQUEST') return
    if (typeof data.messageId !== 'number') return
    const reply = handler(data)
    if (!reply) return
    win.postMessage(
      {
        source: 'LATCH_PROVIDER_RESPONSE',
        messageId: data.messageId,
        ok: reply.ok,
        data: reply.ok ? reply.data : undefined,
        error: reply.ok ? undefined : reply.error,
      },
      win.location.origin
    )
  })
}

describe('inpage window.latch', () => {
  let win: FakePageWindow

  beforeEach(async () => {
    win = installFakePageWindow(ORIGIN)
    vi.resetModules()
    await import('./inpage')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('isConnected returns true when ping succeeds', async () => {
    onProviderRequest(win, (req) => {
      expect(req.method).toBe('ping')
      expect(req.payload).toEqual({})
      return { ok: true, data: { ok: true } }
    })

    await expect(latchOf(win).isConnected()).resolves.toBe(true)
  })

  it('isConnected returns false when ping fails', async () => {
    onProviderRequest(win, () => ({
      ok: false,
      error: { message: 'unreachable', code: 'extension_unreachable' },
    }))

    await expect(latchOf(win).isConnected()).resolves.toBe(false)
  })

  it('isConnected returns false when ping times out', async () => {
    vi.useFakeTimers()
    const pending = latchOf(win).isConnected()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(pending).resolves.toBe(false)
  })

  it('getPublicKey posts origin-scoped request and returns publicKey', async () => {
    onProviderRequest(win, (req) => {
      expect(req).toMatchObject({
        source: 'LATCH_PROVIDER_REQUEST',
        method: 'getPublicKey',
        payload: { origin: ORIGIN },
      })
      return { ok: true, data: { publicKey: SMART } }
    })

    await expect(latchOf(win).getPublicKey()).resolves.toBe(SMART)
  })

  it('signTransaction with object request forwards native payload', async () => {
    const request = {
      xdr: 'AAAAAgAAAAA=',
      network: 'testnet' as const,
      accountToSign: SMART,
      submit: false,
    }
    const response = { signedTxXdr: 'SIGNED' }

    onProviderRequest(win, (req) => {
      expect(req.method).toBe('signTransaction')
      expect(req.payload).toEqual({ origin: ORIGIN, request })
      return { ok: true, data: { response } }
    })

    await expect(latchOf(win).signTransaction(request)).resolves.toEqual(response)
  })

  it('signTransaction with XDR string builds SEP native request then maps response', async () => {
    const requests: BridgeRequest[] = []
    onProviderRequest(win, (req) => {
      requests.push(req)
      if (req.method === 'getPublicKey') {
        return { ok: true, data: { publicKey: SMART } }
      }
      if (req.method === 'getNetwork') {
        return { ok: true, data: { network: 'testnet' } }
      }
      if (req.method === 'signTransaction') {
        return { ok: true, data: { response: { signedTxXdr: 'SIGNED_XDR' } } }
      }
      return { ok: false, error: { message: `unexpected ${req.method}` } }
    })

    const result = await latchOf(win).signTransaction('AAAAAgAAAAA=')

    expect(requests.map((r) => r.method)).toEqual(['getNetwork', 'getPublicKey', 'signTransaction'])
    expect(requests[2]?.payload).toEqual({
      origin: ORIGIN,
      request: {
        xdr: 'AAAAAgAAAAA=',
        network: 'testnet',
        accountToSign: SMART,
        submit: false,
      },
    })
    expect(result).toEqual({ signedTxXdr: 'SIGNED_XDR', signerAddress: SMART })
  })

  it('native signTransaction rejects LatchProviderError on user_rejected', async () => {
    onProviderRequest(win, () => ({
      ok: false,
      error: { message: 'User cancelled', code: 'user_rejected' },
    }))

    await expect(
      latchOf(win).signTransaction({
        xdr: 'AAAA',
        network: 'testnet',
        accountToSign: SMART,
      })
    ).rejects.toMatchObject({
      name: 'LatchProviderError',
      message: 'User cancelled',
      code: 'user_rejected',
    })
  })

  it('ignores response with wrong messageId until matching id arrives', async () => {
    let resolveWrong: (() => void) | undefined
    const wrongPosted = new Promise<void>((resolve) => {
      resolveWrong = resolve
    })

    win.addEventListener('message', (event) => {
      const data = event.data as BridgeRequest
      if (!data || data.source !== 'LATCH_PROVIDER_REQUEST') return
      win.postMessage(
        {
          source: 'LATCH_PROVIDER_RESPONSE',
          messageId: data.messageId + 1,
          ok: true,
          data: { publicKey: 'WRONG' },
        },
        ORIGIN
      )
      resolveWrong?.()
      win.postMessage(
        {
          source: 'LATCH_PROVIDER_RESPONSE',
          messageId: data.messageId,
          ok: true,
          data: { publicKey: SMART },
        },
        ORIGIN
      )
    })

    const pending = latchOf(win).getPublicKey()
    await wrongPosted
    await expect(pending).resolves.toBe(SMART)
  })

  it('SEP signTransaction maps user_rejected to Sep0043ProviderError -4', async () => {
    onProviderRequest(win, (req) => {
      if (req.method === 'getPublicKey') {
        return { ok: true, data: { publicKey: SMART } }
      }
      if (req.method === 'getNetwork') {
        return { ok: true, data: { network: 'testnet' } }
      }
      return {
        ok: false,
        error: { message: 'User cancelled', code: 'user_rejected' },
      }
    })

    // Compare by shape: vi.resetModules() means a static Sep0043ProviderError
    // import would be a different class identity than the one inpage throws.
    await expect(latchOf(win).signTransaction('AAAAAgAAAAA=')).rejects.toMatchObject({
      name: 'Sep0043ProviderError',
      code: -4,
      message: 'User cancelled',
    })
  })

  it('on/off subscribe and unsubscribe accountChanged and networkChanged', async () => {
    const accountHandler = vi.fn()
    const networkHandler = vi.fn()
    const latch = latchOf(win)

    latch.on('accountChanged', accountHandler)
    latch.on('networkChanged', networkHandler)

    win.postMessage(
      {
        source: 'LATCH_PROVIDER_EVENT',
        event: 'accountChanged',
        data: { publicKey: SMART, network: 'testnet' },
      },
      ORIGIN
    )
    win.postMessage(
      {
        source: 'LATCH_PROVIDER_EVENT',
        event: 'networkChanged',
        data: { publicKey: SMART, network: 'mainnet' },
      },
      ORIGIN
    )

    expect(accountHandler).toHaveBeenCalledTimes(1)
    expect(accountHandler).toHaveBeenCalledWith({ publicKey: SMART, network: 'testnet' })
    expect(networkHandler).toHaveBeenCalledTimes(1)
    expect(networkHandler).toHaveBeenCalledWith({ publicKey: SMART, network: 'mainnet' })

    latch.off('accountChanged', accountHandler)
    win.postMessage(
      {
        source: 'LATCH_PROVIDER_EVENT',
        event: 'accountChanged',
        data: { publicKey: SMART, network: 'testnet' },
      },
      ORIGIN
    )
    expect(accountHandler).toHaveBeenCalledTimes(1)

    win.postMessage(
      {
        source: 'LATCH_PROVIDER_EVENT',
        event: 'accountChanged',
        data: { publicKey: '', network: 'testnet' },
      },
      ORIGIN
    )
    // Missing publicKey must not notify remaining listeners.
    expect(networkHandler).toHaveBeenCalledTimes(1)
  })
})
