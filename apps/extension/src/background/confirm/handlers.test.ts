import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackgroundMessage } from '@latch/types'

const setupSend = vi.fn()
const setupSwap = vi.fn()
const executeSend = vi.fn()
const executeSwap = vi.fn()
const finishOutcome = vi.fn()

vi.mock('../backend', () => ({
  BackendError: class BackendError extends Error {
    code?: string
    status?: number
    constructor(message: string, opts?: { code?: string; status?: number }) {
      super(message)
      this.code = opts?.code
      this.status = opts?.status
    }
  },
}))
vi.mock('./executeSendSubmit', () => ({
  executeSendSubmitInBackground: (...a: unknown[]) => executeSend(...a),
  setupSendRulesInBackground: (...a: unknown[]) => setupSend(...a),
}))
vi.mock('./executeSwapConfirm', () => ({
  executeSwapConfirmInBackground: (...a: unknown[]) => executeSwap(...a),
  setupSwapRulesInBackground: (...a: unknown[]) => setupSwap(...a),
}))
vi.mock('./finishOutcome', () => ({ finishOutcome: (...a: unknown[]) => finishOutcome(...a) }))
vi.mock('../knownSacProbes', () => ({ recordKnownSacProbe: vi.fn() }))
vi.mock('../tx/signBuiltTx', () => ({
  resolveAccountsForSign: vi.fn(),
  signAndSubmitBuiltTxInBackground: vi.fn(),
}))
vi.mock('../webauthn/passkeyBridge', () => ({ runPasskeyBridgeAndWait: vi.fn() }))
vi.mock('./executeDappSign', () => ({ executeDappExternalSignInBackground: vi.fn() }))
vi.mock('./executeMultisigApprove', () => ({ executeMultisigPasskeyApproveInBackground: vi.fn() }))

import { BackendError } from '../backend'
import { tryHandleConfirmMessage } from './handlers'
import { __resetInflightForTests } from './inflight'

const ok = ((data: unknown) => ({ ok: true, data })) as never
const payload = {
  accountId: 'a',
  quote: {},
  draft: { recipientAddress: 'C1', amount: '1', token: { code: 'XLM' } },
  surface: 'popup',
  outcomePayload: { draft: 'd' },
}

describe('confirm handlers: settling the pending outcome', () => {
  beforeEach(() => {
    executeSend.mockReset()
    executeSwap.mockReset()
    finishOutcome.mockReset()
    setupSend.mockReset()
    setupSwap.mockReset()
    __resetInflightForTests()
  })

  it.each([
    ['EXECUTE_SEND_SUBMIT', executeSend, 'send'],
    ['EXECUTE_SWAP_CONFIRM', executeSwap, 'swap'],
  ] as const)(
    '%s: a fee refusal settles as review_again, never failure',
    async (type, exec, kind) => {
      exec.mockRejectedValue(
        new BackendError('The network fee changed.', { status: 409, code: 'network_fee_changed' })
      )

      await expect(
        tryHandleConfirmMessage({ type, payload } as unknown as BackgroundMessage, vi.fn(), ok)
      ).rejects.toMatchObject({ code: 'network_fee_changed' })

      expect(finishOutcome).toHaveBeenCalledWith({
        surface: 'popup',
        kind,
        status: 'review_again',
        error: 'The network fee changed.',
        payload: { draft: 'd' },
      })
    }
  )

  it('a review_again refusal (stale review / setup) settles as review_again too', async () => {
    executeSend.mockRejectedValue(
      new BackendError('This review is out of date.', { status: 409, code: 'review_again' })
    )

    await expect(
      tryHandleConfirmMessage(
        { type: 'EXECUTE_SEND_SUBMIT', payload } as unknown as BackgroundMessage,
        vi.fn(),
        ok
      )
    ).rejects.toMatchObject({ code: 'review_again' })

    expect(finishOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send', status: 'review_again' })
    )
  })

  it.each([
    ['EXECUTE_SEND_SUBMIT', executeSend, 'send'],
    ['EXECUTE_SWAP_CONFIRM', executeSwap, 'swap'],
  ] as const)(
    '%s: a double submit runs once and settles the outcome once',
    async (type, exec, kind) => {
      let release!: (v: unknown) => void
      exec.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        })
      )
      const first = vi.fn()
      const second = vi.fn()
      const message = { type, payload } as unknown as BackgroundMessage

      const a = tryHandleConfirmMessage(message, first, ok)
      const b = tryHandleConfirmMessage(message, second, ok)
      release({ status: 'success' })
      await Promise.all([a, b])

      expect(exec).toHaveBeenCalledTimes(1)
      expect(finishOutcome).toHaveBeenCalledTimes(1)
      expect(finishOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ kind, status: 'success' })
      )
      expect(first).toHaveBeenCalledWith({ ok: true, data: { status: 'success' } })
      expect(second).toHaveBeenCalledWith({ ok: true, data: { status: 'success' } })

      exec.mockResolvedValueOnce({ status: 'success' })
      await tryHandleConfirmMessage(message, vi.fn(), ok)
      expect(exec).toHaveBeenCalledTimes(2)
    }
  )

  it('a real failure still settles as failure', async () => {
    executeSend.mockRejectedValue(new Error('boom'))

    await expect(
      tryHandleConfirmMessage(
        { type: 'EXECUTE_SEND_SUBMIT', payload } as unknown as BackgroundMessage,
        vi.fn(),
        ok
      )
    ).rejects.toThrow('boom')

    expect(finishOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send', status: 'failure', error: 'boom' })
    )
  })

  it.each([
    ['RUN_SEND_RULES_SETUP', setupSend, 'send'],
    ['RUN_SWAP_RULES_SETUP', setupSwap, 'swap'],
  ] as const)(
    '%s: a finished setup settles review_again and keeps the draft',
    async (type, setup, kind) => {
      setup.mockResolvedValue('configured')
      const sendResponse = vi.fn()

      await tryHandleConfirmMessage(
        { type, payload: { ...payload, surface: 'sidepanel' } } as unknown as BackgroundMessage,
        sendResponse,
        ok
      )

      expect(finishOutcome).toHaveBeenCalledWith({
        surface: 'sidepanel',
        kind,
        status: 'review_again',
        payload: { draft: 'd' },
      })
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: { result: 'configured' } })
    }
  )

  it.each([
    ['RUN_SEND_RULES_SETUP', setupSend, 'send'],
    ['RUN_SWAP_RULES_SETUP', setupSwap, 'swap'],
  ] as const)(
    '%s: a failed setup settles review_again with the error, then rethrows',
    async (type, setup, kind) => {
      setup.mockRejectedValue(new Error('setup broke'))

      await expect(
        tryHandleConfirmMessage({ type, payload } as unknown as BackgroundMessage, vi.fn(), ok)
      ).rejects.toThrow('setup broke')

      expect(finishOutcome).toHaveBeenCalledWith({
        surface: 'popup',
        kind,
        status: 'review_again',
        error: 'setup broke',
        payload: { draft: 'd' },
      })
    }
  )
})
