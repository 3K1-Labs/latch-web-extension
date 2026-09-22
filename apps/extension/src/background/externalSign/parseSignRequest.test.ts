import { describe, expect, it } from 'vitest'

import { parseSignRequestFromSearchParams } from './parseSignRequest'

const SMART = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'

describe('parseSignRequestFromSearchParams', () => {
  it('parses inline xdr params', () => {
    const req = parseSignRequestFromSearchParams(
      `?network=testnet&account=${SMART}&xdr=AAAA&callback=https://example.com/cb&requestId=rid-1&submit=true`
    )
    expect(req.network).toBe('testnet')
    expect(req.smartAccountAddress).toBe(SMART)
    expect(req.unsignedTxXdr).toBe('AAAA')
    expect(req.callback).toBe('https://example.com/cb')
    expect(req.requestId).toBe('rid-1')
    expect(req.submit).toBe(true)
  })

  it('parses payloadRef and submit=false', () => {
    const req = parseSignRequestFromSearchParams(
      `?network=mainnet&account=${SMART}&payloadRef=sp_abc&callback=http://localhost:3000/cb&submit=false`
    )
    expect(req.network).toBe('mainnet')
    expect(req.payloadRef).toBe('sp_abc')
    expect(req.unsignedTxXdr).toBeUndefined()
    expect(req.submit).toBe(false)
  })

  it('rejects missing account', () => {
    expect(() =>
      parseSignRequestFromSearchParams('?network=testnet&xdr=AAAA&callback=https://example.com/cb')
    ).toThrow(/account/)
  })

  it('rejects invalid contract account', () => {
    expect(() =>
      parseSignRequestFromSearchParams(
        '?network=testnet&account=CABC123&xdr=AAAA&callback=https://example.com/cb'
      )
    ).toThrow(/contract address/)
  })

  it('rejects javascript callback', () => {
    expect(() =>
      parseSignRequestFromSearchParams(
        `?network=testnet&account=${SMART}&xdr=AAAA&callback=javascript:alert(1)`
      )
    ).toThrow(/callback/i)
  })

  it('rejects oversized xdr', () => {
    const huge = 'A'.repeat(256_001)
    expect(() =>
      parseSignRequestFromSearchParams(
        `?network=testnet&account=${SMART}&xdr=${huge}&callback=https://example.com/cb`
      )
    ).toThrow(/maximum size/)
  })
})
