import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OpenSignRequestParams } from '@latch/types'

import { getLatchSDK, LATCH_PUBLIC_METHODS } from './index'

const SAMPLE_PARAMS: OpenSignRequestParams = {
  network: 'testnet',
  account: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
  callback: 'https://dapp.example/callback',
  requestId: 'req-1',
  xdr: 'AAAAAgAAAAA=',
}

function setWindowLatch(latch: Record<string, unknown> | undefined): void {
  ;(globalThis as unknown as { window: { latch?: Record<string, unknown> } }).window = {
    latch,
  }
}

describe('getLatchSDK', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
    vi.restoreAllMocks()
  })

  it('exposes exactly the public method list', () => {
    const latch = {
      isConnected: vi.fn(),
      getPublicKey: vi.fn(),
      signTransaction: vi.fn(),
      openSignRequest: vi.fn(),
      getNetwork: vi.fn(),
      getAddress: vi.fn(),
      getNetworkDetails: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    }
    setWindowLatch(latch)

    expect(Object.keys(getLatchSDK()).sort()).toEqual([...LATCH_PUBLIC_METHODS].sort())
  })

  it('forwards openSignRequest params to window.latch and resolves void', async () => {
    const openSignRequest = vi.fn(async () => undefined)
    setWindowLatch({
      isConnected: vi.fn(),
      getPublicKey: vi.fn(),
      signTransaction: vi.fn(),
      openSignRequest,
      getNetwork: vi.fn(),
      getAddress: vi.fn(),
      getNetworkDetails: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    })

    await expect(getLatchSDK().openSignRequest(SAMPLE_PARAMS)).resolves.toBeUndefined()
    expect(openSignRequest).toHaveBeenCalledTimes(1)
    expect(openSignRequest).toHaveBeenCalledWith(SAMPLE_PARAMS)
  })

  it('throws when the Latch extension is not detected', async () => {
    setWindowLatch(undefined)
    await expect(getLatchSDK().openSignRequest(SAMPLE_PARAMS)).rejects.toThrow(
      'Latch extension not detected'
    )
  })

  it('throws when not in a browser environment', async () => {
    await expect(getLatchSDK().openSignRequest(SAMPLE_PARAMS)).rejects.toThrow(
      'Latch SDK must be used in a browser environment'
    )
  })
})
