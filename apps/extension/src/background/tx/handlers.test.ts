import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackgroundMessage } from '@latch/types'

const buildSendTx = vi.fn()

vi.mock('../backend', () => ({
  buildSendTx: (...a: unknown[]) => buildSendTx(...a),
  buildDelegatedTx: vi.fn(),
  buildTx: vi.fn(),
  setupSendRules: vi.fn(),
  submitTxDelegated: vi.fn(),
  submitTxWebauthn: vi.fn(),
}))
vi.mock('../api/client', () => ({ BackendError: class BackendError extends Error {} }))
vi.mock('../delegatedLocalSign', () => ({ signDelegatedGAddressEntry: vi.fn() }))
vi.mock('../mnemonicSession', () => ({ getMnemonicKeypair: vi.fn() }))
vi.mock('../network/config', () => ({ getActiveNetwork: vi.fn(async () => 'testnet' as const) }))
vi.mock('./enforcingSimProbe', () => ({
  maybeProbeDelegatedEnforcingSim: vi.fn(),
  maybeProbeWebauthnEnforcingSim: vi.fn(),
}))

import { createChromeMock } from '../../test/chromeMock'
import { takeReviewedBuild } from '../confirm/reviewedBuildStore'
import { tryHandleTxMessage } from './handlers'

const ok = ((data: unknown) => ({ ok: true, data })) as never

describe('BUILD_SEND_TX', () => {
  beforeEach(() => {
    globalThis.chrome = createChromeMock() as unknown as typeof chrome
    buildSendTx.mockReset()
  })

  it('holds the build it returns, keyed by the request, for Confirm to sign', async () => {
    const built = { txXdr: 'x' }
    buildSendTx.mockResolvedValue(built)
    const req = { recipient: 'C1', amount: '1', network: 'testnet' }

    await tryHandleTxMessage(
      { type: 'BUILD_SEND_TX', payload: req } as unknown as BackgroundMessage,
      vi.fn(),
      ok
    )

    expect(await takeReviewedBuild('send', { ...req })).toEqual(built)
  })

  it('holds nothing when the build fails', async () => {
    buildSendTx.mockRejectedValue(new Error('nope'))
    const req = { recipient: 'C1', amount: '1', network: 'testnet' }

    await expect(
      tryHandleTxMessage(
        { type: 'BUILD_SEND_TX', payload: req } as unknown as BackgroundMessage,
        vi.fn(),
        ok
      )
    ).rejects.toThrow('nope')
    expect(await takeReviewedBuild('send', req)).toBeNull()
  })

  it('answers before the session-storage write finishes, and Confirm still finds the build', async () => {
    const built = { txXdr: 'slow' }
    buildSendTx.mockResolvedValue(built)
    const req = { recipient: 'C1', amount: '1', network: 'testnet' }
    let release!: () => void
    const realSet = chrome.storage.session.set.bind(chrome.storage.session)
    chrome.storage.session.set = ((items: Record<string, unknown>) =>
      new Promise<void>((resolve) => {
        release = () => {
          void Promise.resolve(realSet(items)).then(() => resolve())
        }
      })) as never
    const sendResponse = vi.fn()

    await tryHandleTxMessage(
      { type: 'BUILD_SEND_TX', payload: req } as unknown as BackgroundMessage,
      sendResponse,
      ok
    )
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: built })

    const taken = takeReviewedBuild('send', req)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    chrome.storage.session.set = realSet as never // only the save's write is held up
    release()
    expect(await taken).toEqual(built)
  })
})
