import { describe, expect, it } from 'vitest'

import {
  MAX_XDR_CHARS,
  parsePublicDappPayload,
  PublicDappPayloadError,
  tryParsePublicDappPayload,
} from './publicDappPayload'

/** Known-valid Stellar contract id used across extension tests. */
const SMART = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'
const ORIGIN = 'https://app.example'

describe('parsePublicDappPayload', () => {
  it('accepts empty or origin-only ping / getNetwork payloads', () => {
    expect(parsePublicDappPayload('PING_EXTENSION', {})).toEqual({})
    expect(parsePublicDappPayload('PING_EXTENSION', { origin: ORIGIN })).toEqual({
      origin: ORIGIN,
    })
    expect(parsePublicDappPayload('GET_ACTIVE_NETWORK', undefined)).toEqual({})
  })

  it('rejects extra fields on ping', () => {
    expect(() => parsePublicDappPayload('PING_EXTENSION', { origin: ORIGIN, evil: 1 })).toThrow(
      PublicDappPayloadError
    )
  })

  it('requires origin for getPublicKey / disconnect / page session', () => {
    expect(parsePublicDappPayload('DAPP_GET_PUBLIC_KEY', { origin: ORIGIN })).toEqual({
      origin: ORIGIN,
    })
    expect(() => parsePublicDappPayload('DAPP_DISCONNECT', {})).toThrow(/origin/)
    expect(() =>
      parsePublicDappPayload('DAPP_PAGE_SESSION_START', { origin: ORIGIN, extra: true })
    ).toThrow(/unexpected field/)
  })

  it('accepts a valid signTransaction payload', () => {
    const parsed = parsePublicDappPayload('DAPP_SIGN_TRANSACTION', {
      origin: ORIGIN,
      request: {
        xdr: 'AAAA',
        network: 'testnet',
        accountToSign: SMART,
        submit: false,
      },
    })
    expect(parsed).toEqual({
      origin: ORIGIN,
      request: {
        xdr: 'AAAA',
        network: 'testnet',
        accountToSign: SMART,
        submit: false,
      },
    })
  })

  it('rejects signTransaction with extra request fields', () => {
    expect(() =>
      parsePublicDappPayload('DAPP_SIGN_TRANSACTION', {
        origin: ORIGIN,
        request: {
          xdr: 'AAAA',
          network: 'testnet',
          accountToSign: SMART,
          callback: 'https://evil.example',
        },
      })
    ).toThrow(/unexpected field/)
  })

  it('rejects invalid network, address, and oversized XDR', () => {
    expect(() =>
      parsePublicDappPayload('DAPP_SIGN_TRANSACTION', {
        origin: ORIGIN,
        request: { xdr: 'AAAA', network: 'devnet', accountToSign: SMART },
      })
    ).toThrow(/network/)

    expect(() =>
      parsePublicDappPayload('DAPP_SIGN_TRANSACTION', {
        origin: ORIGIN,
        request: { xdr: 'AAAA', network: 'testnet', accountToSign: 'CABC' },
      })
    ).toThrow(/contract address/)

    expect(() =>
      parsePublicDappPayload('DAPP_SIGN_TRANSACTION', {
        origin: ORIGIN,
        request: {
          xdr: 'A'.repeat(MAX_XDR_CHARS + 1),
          network: 'testnet',
          accountToSign: SMART,
        },
      })
    ).toThrow(/maximum size/)
  })

  it('rejects non-base64 XDR', () => {
    expect(() =>
      parsePublicDappPayload('DAPP_SIGN_TRANSACTION', {
        origin: ORIGIN,
        request: { xdr: 'not valid!!!', network: 'testnet', accountToSign: SMART },
      })
    ).toThrow(/base64/)
  })

  it('accepts openSignRequest with inline xdr', () => {
    const parsed = parsePublicDappPayload('DAPP_OPEN_SIGN_REQUEST', {
      origin: ORIGIN,
      request: {
        network: 'testnet',
        smartAccountAddress: SMART,
        unsignedTxXdr: 'AAAA',
        callback: 'https://app.example/cb',
        requestId: 'rid-1',
        origin: ORIGIN,
        submit: true,
      },
    })
    expect(parsed).toMatchObject({
      origin: ORIGIN,
      request: {
        network: 'testnet',
        smartAccountAddress: SMART,
        unsignedTxXdr: 'AAAA',
        callback: 'https://app.example/cb',
        requestId: 'rid-1',
      },
    })
  })

  it('accepts openSignRequest with payloadRef and rejects both xdr and ref', () => {
    expect(
      parsePublicDappPayload('DAPP_OPEN_SIGN_REQUEST', {
        origin: ORIGIN,
        request: {
          network: 'mainnet',
          smartAccountAddress: SMART,
          payloadRef: 'sp_abc',
          callback: 'http://localhost:3000/cb',
          requestId: 'rid-2',
        },
      })
    ).toMatchObject({
      request: { payloadRef: 'sp_abc' },
    })

    expect(() =>
      parsePublicDappPayload('DAPP_OPEN_SIGN_REQUEST', {
        origin: ORIGIN,
        request: {
          network: 'testnet',
          smartAccountAddress: SMART,
          unsignedTxXdr: 'AAAA',
          payloadRef: 'sp_abc',
          callback: 'https://app.example/cb',
          requestId: 'rid-3',
        },
      })
    ).toThrow(/exactly one/)
  })

  it('rejects javascript callback and missing required openSignRequest fields', () => {
    expect(() =>
      parsePublicDappPayload('DAPP_OPEN_SIGN_REQUEST', {
        origin: ORIGIN,
        request: {
          network: 'testnet',
          smartAccountAddress: SMART,
          unsignedTxXdr: 'AAAA',
          callback: 'javascript:alert(1)',
          requestId: 'rid-4',
        },
      })
    ).toThrow(/Callback URL/)

    expect(() =>
      parsePublicDappPayload('DAPP_OPEN_SIGN_REQUEST', {
        origin: ORIGIN,
        request: {
          network: 'testnet',
          smartAccountAddress: SMART,
          unsignedTxXdr: 'AAAA',
        },
      })
    ).toThrow(/callback/)
  })

  it('tryParsePublicDappPayload returns validation_error without throwing', () => {
    const result = tryParsePublicDappPayload('DAPP_SIGN_TRANSACTION', { origin: ORIGIN })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error')
      expect(result.error.message).toMatch(/request/)
    }
  })
})
