import { describe, expect, it } from 'vitest'

import type { BackgroundMessage } from '@latch/types'

import { gateBackgroundMessage, isExtensionUiSender } from './messageSource'

const EXT_ID = 'test'

describe('isExtensionUiSender', () => {
  it('accepts popup / side panel / extension tab origins', () => {
    expect(
      isExtensionUiSender({
        id: EXT_ID,
        origin: `chrome-extension://${EXT_ID}`,
        url: `chrome-extension://${EXT_ID}/popup.html`,
      })
    ).toBe(true)

    expect(
      isExtensionUiSender({
        id: EXT_ID,
        origin: `chrome-extension://${EXT_ID}`,
        url: `chrome-extension://${EXT_ID}/tabs/sign-request.html`,
        tab: { id: 1 },
      })
    ).toBe(true)
  })

  it('rejects https page / content-script senders', () => {
    expect(
      isExtensionUiSender({
        id: EXT_ID,
        origin: 'https://evil.example',
        url: 'https://evil.example/app',
        tab: { id: 2 },
      })
    ).toBe(false)
  })
})

describe('gateBackgroundMessage', () => {
  const extensionSender = {
    id: EXT_ID,
    origin: `chrome-extension://${EXT_ID}`,
    url: `chrome-extension://${EXT_ID}/popup.html`,
  }

  const pageSender = {
    id: EXT_ID,
    origin: 'https://app.example',
    url: 'https://app.example/',
    tab: { id: 9 },
  }

  it('allows LOGOUT from extension UI', () => {
    const message = { type: 'LOGOUT', payload: undefined } as BackgroundMessage
    const gate = gateBackgroundMessage(message, extensionSender)
    expect(gate.allowed).toBe(true)
    if (gate.allowed) expect(gate.message.type).toBe('LOGOUT')
  })

  it('blocks LOGOUT and SET_DAPP_PERMISSIONS from content scripts', () => {
    for (const type of ['LOGOUT', 'SET_DAPP_PERMISSIONS'] as const) {
      const gate = gateBackgroundMessage({ type, payload: {} } as BackgroundMessage, pageSender)
      expect(gate.allowed).toBe(false)
      if (!gate.allowed) expect(gate.error.code).toBe('unsupported_method')
    }
  })

  it('allows DAPP_GET_PUBLIC_KEY, PING_EXTENSION, DAPP_PAGE_SESSION_START from CS', () => {
    for (const type of [
      'DAPP_GET_PUBLIC_KEY',
      'PING_EXTENSION',
      'DAPP_PAGE_SESSION_START',
    ] as const) {
      const gate = gateBackgroundMessage(
        { type, payload: { origin: 'https://spoof.example' } } as BackgroundMessage,
        pageSender
      )
      expect(gate.allowed).toBe(true)
      if (gate.allowed) {
        expect(gate.message.type).toBe(type)
        expect((gate.message.payload as { origin: string }).origin).toBe('https://app.example')
      }
    }
  })

  it('blocks CANCEL_REQUEST from content scripts', () => {
    const gate = gateBackgroundMessage(
      { type: 'CANCEL_REQUEST', payload: { requestId: 'x' } } as BackgroundMessage,
      pageSender
    )
    expect(gate.allowed).toBe(false)
  })
})
