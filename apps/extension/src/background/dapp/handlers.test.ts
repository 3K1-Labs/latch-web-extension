import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { BackgroundMessage, PendingDappRequest } from '@latch/types'

const runExternalSignFlow = vi.fn()
vi.mock('../externalSign/orchestrator', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../externalSign/orchestrator')>()
  return {
    ...mod,
    runExternalSignFlow: (...a: unknown[]) => runExternalSignFlow(...a),
  }
})

import { ok } from '../messageResponse'
import type { RuntimeSender } from '../messageSource'
import {
  addPendingDappRequest,
  getDappPermissions,
  isDappOriginDisconnected,
  listPendingDappRequests,
  setDappPermissions,
  upsertAccount,
} from '../storage'
import {
  openApprovalPopup,
  pendingDappResolvers,
  resetDappApprovalSessionForTests,
  waitForExternalSignDecision,
} from './approvalSession'
import { tryHandleDappMessage } from './handlers'
import { getDappRequest, listLiveDappRequests } from './requestState'

const SITE_A = 'https://a.example'
const SITE_B = 'https://b.example'
/** Known-valid Stellar contract id used across extension tests. */
const SMART = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

function pageSender(origin: string): RuntimeSender {
  return {
    id: chrome.runtime.id,
    origin,
    url: `${origin}/`,
    tab: { id: 1, url: `${origin}/` },
  }
}

function disconnect(origin: string) {
  const sendResponse = vi.fn()
  const message = { type: 'DAPP_DISCONNECT', payload: { origin } } as unknown as BackgroundMessage
  return {
    sendResponse,
    handled: tryHandleDappMessage(message, sendResponse, ok, pageSender(origin)),
  }
}

function pageSessionStart(origin: string) {
  const sendResponse = vi.fn()
  const message = {
    type: 'DAPP_PAGE_SESSION_START',
    payload: { origin },
  } as unknown as BackgroundMessage
  return {
    sendResponse,
    handled: tryHandleDappMessage(message, sendResponse, ok, pageSender(origin)),
  }
}

function pendingRow(origin: string, id: string): PendingDappRequest {
  return { id, origin, kind: 'getPublicKey', createdAt: Date.now(), status: 'awaiting_user' }
}

describe('DAPP_DISCONNECT', () => {
  beforeEach(async () => {
    await resetDappApprovalSessionForTests()
    runExternalSignFlow.mockReset()
  })

  it('revokes the calling origin and leaves other sites connected', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])
    await setDappPermissions(SITE_B, ['getPublicKey'])

    const { sendResponse, handled } = disconnect(SITE_A)
    expect(await handled).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: undefined })

    expect(await getDappPermissions(SITE_A)).toEqual([])
    expect(await getDappPermissions(SITE_B)).toEqual(['getPublicKey'])
  })

  it('is idempotent — disconnecting twice still succeeds', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])

    await disconnect(SITE_A).handled
    const { sendResponse, handled } = disconnect(SITE_A)

    expect(await handled).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: undefined })
    expect(await getDappPermissions(SITE_A)).toEqual([])
  })

  it('drops the disconnected origin pending approval without touching another site', async () => {
    await addPendingDappRequest(pendingRow(SITE_A, 'req-a'))
    await addPendingDappRequest(pendingRow(SITE_B, 'req-b'))
    const decisionA = waitForExternalSignDecision('req-a')
    const decisionB = waitForExternalSignDecision('req-b')

    await disconnect(SITE_A).handled

    // errorMessage must be set or the dapp is told the *user* rejected.
    await expect(decisionA).resolves.toEqual({
      approved: false,
      errorCode: 'not_connected',
      errorMessage: 'Site disconnected from Latch',
    })
    expect(pendingDappResolvers.has('req-a')).toBe(false)

    const stillQueued = await listPendingDappRequests()
    expect(stillQueued.map((r) => r.id)).toEqual(['req-b'])
    expect(pendingDappResolvers.has('req-b')).toBe(true)

    pendingDappResolvers.get('req-b')?.({ approved: false })
    await decisionB
  })

  it('blocks provider signing until the site reconnects', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])
    await disconnect(SITE_A).handled

    const message = {
      type: 'DAPP_SIGN_TRANSACTION',
      payload: {
        origin: SITE_A,
        request: { xdr: 'AAAA', network: 'testnet', accountToSign: SMART },
      },
    } as unknown as BackgroundMessage

    await expect(tryHandleDappMessage(message, vi.fn(), ok, pageSender(SITE_A))).rejects.toThrow(
      /not connected/i
    )
    expect(runExternalSignFlow).not.toHaveBeenCalled()
  })

  it('sticky-blocks Grant Access after disconnect so retries cannot spam the UI', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])
    await disconnect(SITE_A).handled

    expect(await isDappOriginDisconnected(SITE_A)).toBe(true)

    const openSpy = vi.spyOn(chrome.action, 'openPopup')
    const createSpy = vi.spyOn(chrome.windows, 'create')

    const message = {
      type: 'DAPP_GET_PUBLIC_KEY',
      payload: { origin: SITE_A },
    } as unknown as BackgroundMessage

    // Must fail closed without opening another Grant Access window.
    await expect(tryHandleDappMessage(message, vi.fn(), ok, pageSender(SITE_A))).rejects.toThrow(
      /not connected/i
    )
    expect(openSpy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('DAPP_PAGE_SESSION_START clears sticky disconnect so reconnect can prompt', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])
    await disconnect(SITE_A).handled
    expect(await isDappOriginDisconnected(SITE_A)).toBe(true)

    const { sendResponse, handled } = pageSessionStart(SITE_A)
    expect(await handled).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: undefined })
    expect(await isDappOriginDisconnected(SITE_A)).toBe(false)

    vi.spyOn(chrome.action, 'openPopup').mockResolvedValue(undefined as never)
    const getKey = {
      type: 'DAPP_GET_PUBLIC_KEY',
      payload: { origin: SITE_A },
    } as unknown as BackgroundMessage

    const enqueueResponse = vi.fn()
    expect(await tryHandleDappMessage(getKey, enqueueResponse, ok, pageSender(SITE_A))).toBe(true)
    expect(enqueueResponse).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({
        requestId: expect.any(String),
        status: 'awaiting_user',
      }),
    })
  })

  it('closes the durable approval window when a pending request is resolved', async () => {
    vi.spyOn(chrome.action, 'openPopup').mockRejectedValue(new Error('no user gesture'))
    const removeSpy = vi.spyOn(chrome.windows, 'remove')

    await openApprovalPopup(SITE_A)
    await addPendingDappRequest(pendingRow(SITE_A, 'req-close'))
    waitForExternalSignDecision('req-close')

    const sendResponse = vi.fn()
    await tryHandleDappMessage(
      {
        type: 'RESOLVE_PENDING_DAPP_REQUEST',
        payload: { requestId: 'req-close', approved: true },
      } as unknown as BackgroundMessage,
      sendResponse,
      ok
    )

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: undefined })
    expect(removeSpy).toHaveBeenCalledWith(99)
  })

  it('rejects disconnect when payload origin does not match sender', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])

    await expect(
      tryHandleDappMessage(
        {
          type: 'DAPP_DISCONNECT',
          payload: { origin: SITE_B },
        } as unknown as BackgroundMessage,
        vi.fn(),
        ok,
        pageSender(SITE_A)
      )
    ).rejects.toThrow(/does not match/)

    expect(await getDappPermissions(SITE_A)).toEqual(['getPublicKey'])
  })

  it('passes senderUrl into provider sign flow and returns pending ack', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])
    runExternalSignFlow.mockResolvedValue({
      pending: true,
      requestId: 'sign-req-1',
    })

    const sendResponse = vi.fn()
    await tryHandleDappMessage(
      {
        type: 'DAPP_SIGN_TRANSACTION',
        payload: {
          origin: SITE_A,
          request: { xdr: 'AAAA', network: 'testnet', accountToSign: SMART },
        },
      } as unknown as BackgroundMessage,
      sendResponse,
      ok,
      pageSender(SITE_A)
    )

    expect(runExternalSignFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'provider',
        senderUrl: `${SITE_A}/`,
        awaitDecision: false,
        request: expect.objectContaining({ origin: SITE_A }),
      })
    )
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      data: { requestId: 'sign-req-1', status: 'awaiting_user' },
    })
  })

  it('rejects malformed signTransaction before runExternalSignFlow', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])

    await expect(
      tryHandleDappMessage(
        {
          type: 'DAPP_SIGN_TRANSACTION',
          payload: {
            origin: SITE_A,
            request: { xdr: 'AAAA', network: 'devnet', accountToSign: SMART },
          },
        } as unknown as BackgroundMessage,
        vi.fn(),
        ok,
        pageSender(SITE_A)
      )
    ).rejects.toThrow(/network/)

    expect(runExternalSignFlow).not.toHaveBeenCalled()
  })

  it('SET_DAPP_PERMISSIONS still uses payload dapp origin (extension UI)', async () => {
    const sendResponse = vi.fn()
    await tryHandleDappMessage(
      {
        type: 'SET_DAPP_PERMISSIONS',
        payload: { origin: SITE_B, allowed: ['getPublicKey'] },
      } as unknown as BackgroundMessage,
      sendResponse,
      ok,
      {
        id: chrome.runtime.id,
        origin: `chrome-extension://${chrome.runtime.id}`,
        url: `chrome-extension://${chrome.runtime.id}/popup.html`,
      }
    )

    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      data: { origin: SITE_B, allowed: ['getPublicKey'] },
    })
    expect(await getDappPermissions(SITE_B)).toEqual(['getPublicKey'])
  })
})

describe('restart-safe dApp request state machine', () => {
  beforeEach(async () => {
    await resetDappApprovalSessionForTests()
    runExternalSignFlow.mockReset()
    await upsertAccount({
      id: 'acc-1',
      label: 'Test',
      mode: 'passkey',
      smartAccountAddress: SMART,
      createdAt: Date.now(),
    })
  })

  it('LIST keeps awaiting rows after in-memory resolvers are wiped (SW reinit)', async () => {
    await addPendingDappRequest(pendingRow(SITE_A, 'req-live'))
    pendingDappResolvers.clear()

    const sendResponse = vi.fn()
    await tryHandleDappMessage(
      { type: 'LIST_PENDING_DAPP_REQUESTS', payload: {} } as BackgroundMessage,
      sendResponse,
      ok
    )

    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      data: { requests: [expect.objectContaining({ id: 'req-live', status: 'awaiting_user' })] },
    })
    expect(await listLiveDappRequests()).toHaveLength(1)
  })

  it('resolve after SW reinit is pollable and idempotent', async () => {
    await addPendingDappRequest(pendingRow(SITE_A, 'req-poll'))
    // Simulate service-worker restart: drop in-memory waiters only.
    pendingDappResolvers.clear()

    const resolveOnce = vi.fn()
    await tryHandleDappMessage(
      {
        type: 'RESOLVE_PENDING_DAPP_REQUEST',
        payload: { requestId: 'req-poll', approved: true },
      } as BackgroundMessage,
      resolveOnce,
      ok
    )
    expect(resolveOnce).toHaveBeenCalledWith({ ok: true, data: undefined })

    const resolveTwice = vi.fn()
    await tryHandleDappMessage(
      {
        type: 'RESOLVE_PENDING_DAPP_REQUEST',
        payload: { requestId: 'req-poll', approved: true },
      } as BackgroundMessage,
      resolveTwice,
      ok
    )
    expect(resolveTwice).toHaveBeenCalledWith({ ok: true, data: undefined })

    const stored = await getDappRequest('req-poll')
    expect(stored?.status).toBe('approved')

    const poll = vi.fn()
    await tryHandleDappMessage(
      {
        type: 'DAPP_POLL_REQUEST_RESULT',
        payload: { requestId: 'req-poll', origin: SITE_A },
      } as BackgroundMessage,
      poll,
      ok,
      pageSender(SITE_A)
    )
    expect(poll).toHaveBeenCalledWith({
      ok: true,
      data: { status: 'approved', publicKey: SMART },
    })
    expect(await getDappPermissions(SITE_A)).toEqual(['getPublicKey'])
  })

  it('rejects cross-origin poll of another site requestId', async () => {
    await addPendingDappRequest(pendingRow(SITE_A, 'req-secret'))

    await expect(
      tryHandleDappMessage(
        {
          type: 'DAPP_POLL_REQUEST_RESULT',
          payload: { requestId: 'req-secret', origin: SITE_B },
        } as BackgroundMessage,
        vi.fn(),
        ok,
        pageSender(SITE_B)
      )
    ).rejects.toThrow(/unknown request/i)
  })

  it('expires stale awaiting requests out of LIST and on poll', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    await addPendingDappRequest({
      id: 'req-old',
      origin: SITE_A,
      kind: 'getPublicKey',
      createdAt: now,
      status: 'awaiting_user',
      updatedAt: now,
    })

    vi.setSystemTime(now + 6 * 60 * 1000)

    const listRes = vi.fn()
    await tryHandleDappMessage(
      { type: 'LIST_PENDING_DAPP_REQUESTS', payload: {} } as BackgroundMessage,
      listRes,
      ok
    )
    expect(listRes).toHaveBeenCalledWith({ ok: true, data: { requests: [] } })

    const poll = vi.fn()
    await tryHandleDappMessage(
      {
        type: 'DAPP_POLL_REQUEST_RESULT',
        payload: { requestId: 'req-old', origin: SITE_A },
      } as BackgroundMessage,
      poll,
      ok,
      pageSender(SITE_A)
    )
    expect(poll).toHaveBeenCalledWith({
      ok: true,
      data: {
        status: 'expired',
        error: { message: 'Request expired', code: 'expired' },
      },
    })

    vi.useRealTimers()
  })
})
