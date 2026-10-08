import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SwapQuoteRequest } from '../types'
import { soroswapProvider } from './soroswap'

const HASH = 'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0'
const TOKEN_A = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
const TOKEN_B = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const TOKEN_C = 'CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2'
const TOKEN_D = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

function request(): SwapQuoteRequest {
  return {
    network: 'mainnet',
    assetIn: {
      assetId: 'native',
      symbol: 'XLM',
      contractId: TOKEN_A,
      decimals: 7,
    },
    assetOut: {
      assetId: 'usdc',
      symbol: 'USDC',
      contractId: TOKEN_B,
      decimals: 7,
    },
    amountInRaw: '10000000',
    slippageBps: 50,
    recipient: 'C'.padEnd(56, 'A'),
  }
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    async json() {
      return body
    },
  }
}

describe('soroswapProvider.quote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.PLASMO_PUBLIC_SOROSWAP_API_KEY
  })

  it('re-quotes without aqua when pool hashes are missing and uses that amountOut', async () => {
    process.env.PLASMO_PUBLIC_SOROSWAP_API_KEY = 'test-key'
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (bodies.length === 1) {
          return jsonResponse({
            amountOut: '111',
            rawTrade: {
              distribution: [
                {
                  protocol_id: 'aqua',
                  path: [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D],
                  parts: 10,
                },
              ],
            },
          })
        }
        return jsonResponse({
          amountOut: '222',
          rawTrade: {
            distribution: [
              {
                protocol_id: 'soroswap',
                path: [TOKEN_A, TOKEN_B],
                parts: 10,
              },
            ],
          },
        })
      })
    )

    const quote = await soroswapProvider.quote(request())
    expect(quote.amountOutRaw).toBe('222')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.protocols).toEqual(['soroswap', 'phoenix', 'aqua'])
    expect(bodies[1]?.protocols).toEqual(['soroswap', 'phoenix'])
  })

  it('keeps a valid aqua quote and does not send a second request', async () => {
    process.env.PLASMO_PUBLIC_SOROSWAP_API_KEY = 'test-key'
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        amountOut: '333',
        rawTrade: {
          distribution: [
            {
              protocol_id: 'aqua',
              path: [TOKEN_A, TOKEN_B],
              parts: 10,
              poolHashes: [HASH],
            },
          ],
        },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const quote = await soroswapProvider.quote(request())
    expect(quote.amountOutRaw).toBe('333')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
