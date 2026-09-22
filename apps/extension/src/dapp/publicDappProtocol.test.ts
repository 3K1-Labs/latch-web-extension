import { describe, expect, it } from 'vitest'

import {
  CONTENT_SCRIPT_MESSAGE_TYPES,
  isContentScriptAllowedMessageType,
  isPublicDappMethod,
  pinDappOrigin,
  PUBLIC_DAPP_METHODS,
  publicMethodToMessageType,
  unsupportedProviderError,
} from './publicDappProtocol'

describe('publicDappProtocol', () => {
  it('maps every public method to an internal MessageType', () => {
    expect(PUBLIC_DAPP_METHODS).toEqual([
      'ping',
      'getNetwork',
      'getPublicKey',
      'signTransaction',
      'openSignRequest',
      'disconnect',
    ])
    expect(publicMethodToMessageType('ping')).toBe('PING_EXTENSION')
    expect(publicMethodToMessageType('getNetwork')).toBe('GET_ACTIVE_NETWORK')
    expect(publicMethodToMessageType('getPublicKey')).toBe('DAPP_GET_PUBLIC_KEY')
    expect(publicMethodToMessageType('signTransaction')).toBe('DAPP_SIGN_TRANSACTION')
    expect(publicMethodToMessageType('openSignRequest')).toBe('DAPP_OPEN_SIGN_REQUEST')
    expect(publicMethodToMessageType('disconnect')).toBe('DAPP_DISCONNECT')
  })

  it('rejects internal MessageTypes and CS-only types as public methods', () => {
    expect(isPublicDappMethod('LOGOUT')).toBe(false)
    expect(isPublicDappMethod('SET_DAPP_PERMISSIONS')).toBe(false)
    expect(isPublicDappMethod('RESOLVE_PENDING_DAPP_REQUEST')).toBe(false)
    expect(isPublicDappMethod('DAPP_PAGE_SESSION_START')).toBe(false)
    expect(isPublicDappMethod('DAPP_GET_PUBLIC_KEY')).toBe(false)
    expect(isPublicDappMethod('ping')).toBe(true)
  })

  it('includes mapped types plus CS-only session/poll types', () => {
    expect(CONTENT_SCRIPT_MESSAGE_TYPES).toContain('PING_EXTENSION')
    expect(CONTENT_SCRIPT_MESSAGE_TYPES).toContain('DAPP_GET_PUBLIC_KEY')
    expect(CONTENT_SCRIPT_MESSAGE_TYPES).toContain('DAPP_PAGE_SESSION_START')
    expect(CONTENT_SCRIPT_MESSAGE_TYPES).toContain('DAPP_POLL_REQUEST_RESULT')
    expect(isContentScriptAllowedMessageType('LOGOUT')).toBe(false)
    expect(isContentScriptAllowedMessageType('SET_DAPP_PERMISSIONS')).toBe(false)
    expect(isContentScriptAllowedMessageType('CANCEL_REQUEST')).toBe(false)
    expect(isContentScriptAllowedMessageType('DAPP_PAGE_SESSION_START')).toBe(true)
    expect(isContentScriptAllowedMessageType('DAPP_POLL_REQUEST_RESULT')).toBe(true)
    expect(isPublicDappMethod('DAPP_POLL_REQUEST_RESULT')).toBe(false)
  })

  it('returns a stable unsupported_method error', () => {
    expect(unsupportedProviderError()).toEqual({
      message: 'Unsupported provider method',
      code: 'unsupported_method',
    })
  })

  it('pinDappOrigin overwrites spoofed top-level and nested request.origin', () => {
    const pinned = pinDappOrigin(
      {
        origin: 'https://evil.example',
        request: { origin: 'https://evil.example', xdr: 'AAAA' },
        other: 1,
      },
      'https://honest.example'
    )
    expect(pinned).toEqual({
      origin: 'https://honest.example',
      request: { origin: 'https://honest.example', xdr: 'AAAA' },
      other: 1,
    })
  })

  it('pinDappOrigin sets origin on plain objects without mutating non-objects', () => {
    expect(pinDappOrigin({}, 'https://a.example')).toEqual({ origin: 'https://a.example' })
    expect(pinDappOrigin(undefined, 'https://a.example')).toBeUndefined()
    expect(pinDappOrigin(null, 'https://a.example')).toBeNull()
    expect(pinDappOrigin('x', 'https://a.example')).toBe('x')
  })
})
