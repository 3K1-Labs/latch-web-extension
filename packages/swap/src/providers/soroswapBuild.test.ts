import { nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import {
  buildDexDistributionScVal,
  dexDistributionEntryToScVal,
  extractAggregatorAmountOut,
} from './soroswapBuild'
import {
  parseSoroswapDistribution,
  poolHashToBytes,
  soroswapProtocolIdToU32,
} from './soroswapQuote'

describe('soroswapProtocolIdToU32', () => {
  it('maps aggregator Protocol enum values', () => {
    expect(soroswapProtocolIdToU32('soroswap')).toBe(0)
    expect(soroswapProtocolIdToU32('phoenix')).toBe(1)
    expect(soroswapProtocolIdToU32('aqua')).toBe(2)
    expect(soroswapProtocolIdToU32('aquarius')).toBe(2)
    expect(soroswapProtocolIdToU32('comet')).toBe(3)
  })
})

describe('poolHashToBytes', () => {
  it('decodes 64-char hex Aquarius indexes to 32 bytes', () => {
    const hex = 'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0'
    const buf = poolHashToBytes(hex)
    expect(buf.length).toBe(32)
    expect(buf.toString('hex')).toBe(hex)
  })

  it('decodes Base64 pool hashes', () => {
    const hex = 'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0'
    const b64 = Buffer.from(hex, 'hex').toString('base64')
    expect(poolHashToBytes(b64).toString('hex')).toBe(hex)
  })
})

const TOKEN_A = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
const TOKEN_B = 'CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2'
const TOKEN_C = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const HASH_A = 'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0'
const HASH_B = '24f9c991c44acf33fff5f44031c40385d235dc212d7379e824ba3db1c35371f3'

describe('parseSoroswapDistribution', () => {
  it('parses aqua distribution from a quote payload', () => {
    const entries = parseSoroswapDistribution({
      rawTrade: {
        distribution: [
          {
            protocol_id: 'aqua',
            path: [TOKEN_A, TOKEN_B, TOKEN_C],
            parts: 10,
            poolHashes: [HASH_A, HASH_B],
          },
        ],
      },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].protocolId).toBe('aqua')
    expect(entries[0].parts).toBe(10)
    expect(entries[0].poolHashes).toHaveLength(2)
  })

  it('reads aqua hashes from pool_hashes and from bytes', () => {
    const fromSnake = parseSoroswapDistribution({
      rawTrade: {
        distribution: [
          { protocol_id: 'aqua', path: [TOKEN_A, TOKEN_B], parts: 10, pool_hashes: [HASH_A] },
        ],
      },
    })
    const fromBytes = parseSoroswapDistribution({
      rawTrade: {
        distribution: [
          { protocol_id: 'aquarius', path: [TOKEN_A, TOKEN_B], parts: 4, bytes: [HASH_A] },
        ],
      },
    })
    expect(fromSnake[0].poolHashes).toEqual([HASH_A])
    expect(fromBytes[0].poolHashes).toEqual([HASH_A])

    const scVal = dexDistributionEntryToScVal(fromSnake[0])
    const bytesEntry = scVal.map()!.find((e) => e.key().sym().toString() === 'bytes')!
    expect(bytesEntry.val().vec()).toHaveLength(1)
    expect(Buffer.from(bytesEntry.val().vec()![0].bytes()).toString('hex')).toBe(HASH_A)
  })

  it('rejects an aqua route with a missing or short hash list before XDR build', () => {
    expect(() =>
      parseSoroswapDistribution({
        rawTrade: {
          distribution: [{ protocol_id: 'aqua', path: [TOKEN_A, TOKEN_B, TOKEN_C], parts: 10 }],
        },
      })
    ).toThrow(/missing pool hashes/)

    expect(() =>
      parseSoroswapDistribution({
        rawTrade: {
          distribution: [
            {
              protocol_id: 'aqua',
              path: [TOKEN_A, TOKEN_B, TOKEN_C],
              parts: 10,
              poolHashes: [HASH_A],
            },
          ],
        },
      })
    ).toThrow(/expected 2/)
  })
})

describe('dexDistributionEntryToScVal', () => {
  it('encodes sorted map keys and aqua protocol u32', () => {
    const scVal = dexDistributionEntryToScVal({
      protocolId: 'aqua',
      path: [
        'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      ],
      parts: 10,
      poolHashes: ['b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0'],
    })

    expect(scVal.switch().name).toBe('scvMap')
    const map = scVal.map()!
    const keys = map.map((e) => e.key().sym().toString())
    expect(keys).toEqual(['bytes', 'parts', 'path', 'protocol_id'])

    const protocolEntry = map.find((e) => e.key().sym().toString() === 'protocol_id')!
    expect(protocolEntry.val().u32()).toBe(2)

    const partsEntry = map.find((e) => e.key().sym().toString() === 'parts')!
    expect(partsEntry.val().u32()).toBe(10)

    const bytesEntry = map.find((e) => e.key().sym().toString() === 'bytes')!
    expect(bytesEntry.val().switch().name).toBe('scvVec')
    expect(bytesEntry.val().vec()!).toHaveLength(1)
    expect(Buffer.from(bytesEntry.val().vec()![0].bytes()).toString('hex')).toBe(
      'b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0'
    )
  })

  it('encodes missing poolHashes as Option::None (void)', () => {
    const scVal = dexDistributionEntryToScVal({
      protocolId: 'soroswap',
      path: [
        'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      ],
      parts: 5,
    })
    const map = scVal.map()!
    const bytesEntry = map.find((e) => e.key().sym().toString() === 'bytes')!
    expect(bytesEntry.val().switch()).toBe(xdr.ScValType.scvVoid())
  })
})

describe('buildDexDistributionScVal', () => {
  it('wraps entries in a vec', () => {
    const scVal = buildDexDistributionScVal([
      {
        protocolId: 'soroswap',
        path: [
          'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
          'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        ],
        parts: 10,
      },
    ])
    expect(scVal.switch().name).toBe('scvVec')
    expect(scVal.vec()!).toHaveLength(1)
  })
})

describe('extractAggregatorAmountOut', () => {
  it('sums the last hop of each route', () => {
    const built = xdr.ScVal.scvVec([
      xdr.ScVal.scvVec([
        nativeToScVal(1000000n, { type: 'i128' }),
        nativeToScVal(176001n, { type: 'i128' }),
      ]),
      xdr.ScVal.scvVec([
        nativeToScVal(500000n, { type: 'i128' }),
        nativeToScVal(80000n, { type: 'i128' }),
      ]),
    ])
    expect(extractAggregatorAmountOut(built)).toBe(256001n)
  })
})
