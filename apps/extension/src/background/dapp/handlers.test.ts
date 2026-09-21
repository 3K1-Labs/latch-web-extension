import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { BackgroundMessage, PendingDappRequest } from '@latch/types'

const runExternalSignFlow = vi.fn()
vi.mock('../externalSign/orchestrator', () => ({
  runExternalSignFlow: (...a: unknown[]) => runExternalSignFlow(...a),
}))

import { ok } from '../messageResponse'
import type { RuntimeSender } from '../messageSource'
import {
  addPendingDappRequest,
  getDappPermissions,
  isDappOriginDisconnected,
  listPendingDappRequests,
  setDappPermissions,
} from '../storage'
import {
  openApprovalPopup,
  pendingDappResolvers,
  resetDappApprovalSessionForTests,
  waitForExternalSignDecision,
} from './approvalSession'
import { tryHandleDappMessage } from './handlers'

const SITE_A = 'https://a.example'
const SITE_B = 'https://b.example'

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
  return { id, origin, kind: 'getPublicKey', createdAt: 0 }
}

describe('DAPP_DISCONNECT', () => {
  beforeEach(() => {
    resetDappApprovalSessionForTests()
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
        request: { xdr: 'AAAA', network: 'testnet', accountToSign: 'CABC' },
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

    // Without permissions, getPublicKey should now be allowed to open approval
    // (we only assert it does not fail closed on the sticky flag).
    vi.spyOn(chrome.action, 'openPopup').mockResolvedValue(undefined as never)
    const getKey = {
      type: 'DAPP_GET_PUBLIC_KEY',
      payload: { origin: SITE_A },
    } as unknown as BackgroundMessage

    // Starts approval (hangs until resolved) — prove it was not rejected as not_connected.
    const approvalPromise = tryHandleDappMessage(getKey, vi.fn(), ok, pageSender(SITE_A))
    await vi.waitFor(() => {
      expect(pendingDappResolvers.size).toBe(1)
    })
    const requestId = [...pendingDappResolvers.keys()][0]!
    pendingDappResolvers.get(requestId)?.({ approved: false, errorCode: 'user_rejected' })
    await expect(approvalPromise).rejects.toThrow(/rejected/i)
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

  it('passes senderUrl into provider sign flow', async () => {
    await setDappPermissions(SITE_A, ['getPublicKey'])
    runExternalSignFlow.mockResolvedValue({
      status: 'signed',
      signedXdr: 'SIGNED',
      network: 'testnet',
    })

    const sendResponse = vi.fn()
    await tryHandleDappMessage(
      {
        type: 'DAPP_SIGN_TRANSACTION',
        payload: {
          origin: SITE_A,
          request: { xdr: 'AAAA', network: 'testnet', accountToSign: 'CABC' },
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
        request: expect.objectContaining({ origin: SITE_A }),
      })
    )
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
