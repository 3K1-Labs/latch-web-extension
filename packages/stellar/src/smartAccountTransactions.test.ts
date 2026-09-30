import { Address, Asset, Keypair, scValToNative, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  buildSacAssetInfoMap,
  buildSacProbesForHistory,
  classifyPaymentTxTypes,
  fetchSmartAccountPayments,
  stellarAddressEquals,
  type SmartAccountPayment,
} from './smartAccountTransactions'

const PASSPHRASE = 'Test SDF Network ; September 2015'
const C_SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const G_CLASSIC = 'GBBD47IF6L27R6SAA3BVWFXNUG7QLYZNH7ZWK5CT4OEK2LDXZ2BJZK2'
const BUNDLER_G = 'GBL4FMN3MPLPA2IS7T2K5VAGGVT4WJWJ24YXYFAHIFOGGCVEM6WVVAQA'
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const SENDER = Keypair.random().publicKey()

function horizonAccountJson(balances: unknown[]) {
  return {
    id: G_CLASSIC,
    sequence: '1',
    subentry_count: balances.length,
    balances,
  }
}

function scValTopicB64(val: xdr.ScVal): string {
  return val.toXDR('base64')
}

function makeTransferEvent(params: {
  from: string
  to: string
  amountRaw: bigint
  txHash: string
  eventId: string
  ledgerClosedAt: string
  contractId?: string
}): Record<string, unknown> {
  const amountParts = new xdr.Int128Parts({
    hi: xdr.Int64.fromString('0'),
    lo: xdr.Uint64.fromString(params.amountRaw.toString()),
  })
  return {
    id: params.eventId,
    txHash: params.txHash,
    contractId: params.contractId ?? Asset.native().contractId(PASSPHRASE),
    topic: [
      scValTopicB64(xdr.ScVal.scvSymbol('transfer')),
      scValTopicB64(new Address(params.from).toScVal()),
      scValTopicB64(new Address(params.to).toScVal()),
    ],
    value: scValTopicB64(xdr.ScVal.scvI128(amountParts)),
    ledgerClosedAt: params.ledgerClosedAt,
  }
}

describe('stellarAddressEquals', () => {
  it('compares strkeys via Address normalization', () => {
    expect(stellarAddressEquals(SENDER, SENDER)).toBe(true)
    expect(stellarAddressEquals(SENDER, C_SMART)).toBe(false)
  })
})

describe('buildSacAssetInfoMap', () => {
  it('includes native XLM and curated USDC for testnet', () => {
    const map = buildSacAssetInfoMap({ networkPassphrase: PASSPHRASE, network: 'testnet' })
    const nativeId = Asset.native().contractId(PASSPHRASE)
    expect(map.get(nativeId)?.code).toBe('XLM')
    const usdcId = new Asset('USDC', USDC_ISSUER).contractId(PASSPHRASE)
    expect(map.get(usdcId)?.code).toBe('USDC')
  })
})

describe('classifyPaymentTxTypes', () => {
  it('marks multi-asset out+in under one hash as swap', () => {
    const payments: SmartAccountPayment[] = [
      {
        id: '1',
        transactionHash: 'swap-hash',
        type: 'invoke_host_function',
        from: C_SMART,
        to: SENDER,
        amount: '10',
        assetType: 'native',
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: '2',
        transactionHash: 'swap-hash',
        type: 'invoke_host_function',
        from: SENDER,
        to: C_SMART,
        amount: '5',
        assetType: 'credit_alphanum4',
        assetCode: 'USDC',
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]
    const classified = classifyPaymentTxTypes(payments, C_SMART)
    expect(classified.every((p) => p.txType === 'swap')).toBe(true)
  })

  it('marks simple send/receive', () => {
    const payments: SmartAccountPayment[] = [
      {
        id: '1',
        transactionHash: 'send-hash',
        type: 'payment',
        from: C_SMART,
        to: SENDER,
        amount: '1',
        assetType: 'native',
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: '2',
        transactionHash: 'recv-hash',
        type: 'payment',
        from: SENDER,
        to: C_SMART,
        amount: '2',
        assetType: 'native',
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]
    const classified = classifyPaymentTxTypes(payments, C_SMART)
    expect(classified[0]!.txType).toBe('send')
    expect(classified[1]!.txType).toBe('receive')
  })
})

describe('buildSacProbesForHistory', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('includes native XLM and G trustline SAC contracts', async () => {
    const usdcSac = new Asset('USDC', USDC_ISSUER).contractId(PASSPHRASE)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              horizonAccountJson([
                { asset_type: 'native', balance: '10.0000000' },
                {
                  asset_type: 'credit_alphanum4',
                  asset_code: 'USDC',
                  asset_issuer: USDC_ISSUER,
                  balance: '5.0000000',
                },
              ])
            )
          )
      )
    )

    const probes = await buildSacProbesForHistory({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
      gAddress: G_CLASSIC,
    })

    expect(probes.some((p) => p.code === 'XLM')).toBe(true)
    expect(probes.some((p) => p.code === 'USDC' && p.sacContractId === usdcSac)).toBe(true)
  })
})

describe('fetchSmartAccountPayments', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses asset_balance_changes for G-address invoke ops (multi-leg)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes(`/accounts/${G_CLASSIC}/operations`) && init?.method !== 'POST') {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  id: 'op-1',
                  type: 'invoke_host_function',
                  transaction_hash: 'hash-multi',
                  source_account: G_CLASSIC,
                  created_at: '2024-01-01T00:00:00Z',
                  asset_balance_changes: [
                    {
                      from: C_SMART,
                      to: SENDER,
                      amount: '10.0000000',
                      asset_type: 'native',
                    },
                    {
                      from: SENDER,
                      to: C_SMART,
                      amount: '5.0000000',
                      asset_type: 'credit_alphanum4',
                      asset_code: 'USDC',
                    },
                  ],
                },
              ],
            },
          })
        )
      }
      if (u.includes('/accounts/') && !u.includes('/operations') && init?.method !== 'POST') {
        return new Response(
          JSON.stringify(horizonAccountJson([{ asset_type: 'native', balance: '1.0000000' }]))
        )
      }
      if (init?.method === 'POST' && String(init.body).includes('getLatestLedger')) {
        return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
      }
      if (init?.method === 'POST' && String(init.body).includes('getEvents')) {
        return new Response(JSON.stringify({ result: { events: [] } }))
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchSmartAccountPayments({
      cAddress: C_SMART,
      gAddress: G_CLASSIC,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
      network: 'testnet',
    })

    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.txType === 'swap')).toBe(true)
  })

  it('maps classic payment and create_account ops', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes(`/accounts/${G_CLASSIC}/operations`) && init?.method !== 'POST') {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  id: 'pay-1',
                  type: 'payment',
                  transaction_hash: 'pay-hash',
                  from: SENDER,
                  to: G_CLASSIC,
                  amount: '3.0000000',
                  asset_type: 'native',
                  created_at: '2024-02-01T00:00:00Z',
                },
                {
                  id: 'create-1',
                  type: 'create_account',
                  transaction_hash: 'create-hash',
                  funder: SENDER,
                  account: G_CLASSIC,
                  starting_balance: '100.0000000',
                  created_at: '2024-01-01T00:00:00Z',
                },
              ],
            },
          })
        )
      }
      if (u.includes('/accounts/') && !u.includes('/operations') && init?.method !== 'POST') {
        return new Response(
          JSON.stringify(horizonAccountJson([{ asset_type: 'native', balance: '1.0000000' }]))
        )
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string }
        if (body.method === 'getLatestLedger') {
          return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
        }
        return new Response(JSON.stringify({ result: { events: [] } }))
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchSmartAccountPayments({
      cAddress: C_SMART,
      gAddress: G_CLASSIC,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
    })

    expect(rows.some((r) => r.transactionHash === 'pay-hash' && r.to === C_SMART)).toBe(true)
    expect(rows.some((r) => r.transactionHash === 'create-hash' && r.to === C_SMART)).toBe(true)
  })

  it('fetches bundler ops for passkey accounts (no gAddress)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes(`/accounts/${BUNDLER_G}/operations`) && init?.method !== 'POST') {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  id: 'bundler-op-1',
                  type: 'invoke_host_function',
                  transaction_hash: 'bundler-tx',
                  source_account: BUNDLER_G,
                  created_at: '2024-03-01T00:00:00Z',
                  asset_balance_changes: [
                    {
                      from: C_SMART,
                      to: SENDER,
                      amount: '1.5000000',
                      asset_type: 'native',
                    },
                  ],
                },
                {
                  id: 'bundler-op-other',
                  type: 'invoke_host_function',
                  transaction_hash: 'other-tx',
                  source_account: BUNDLER_G,
                  created_at: '2024-03-01T00:00:00Z',
                  asset_balance_changes: [
                    {
                      from: SENDER,
                      to: Keypair.random().publicKey(),
                      amount: '9.0000000',
                      asset_type: 'native',
                    },
                  ],
                },
              ],
            },
          })
        )
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string }
        if (body.method === 'getLatestLedger') {
          return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
        }
        return new Response(JSON.stringify({ result: { events: [] } }))
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchSmartAccountPayments({
      cAddress: C_SMART,
      bundlerGAddress: BUNDLER_G,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.transactionHash).toBe('bundler-tx')
    expect(rows[0]!.txType).toBe('send')
  })

  it('returns empty bundler results when bundlerGAddress is omitted', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string }
        if (body.method === 'getLatestLedger') {
          return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
        }
        return new Response(JSON.stringify({ result: { events: [] } }))
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchSmartAccountPayments({
      cAddress: C_SMART,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
    })

    expect(rows).toHaveLength(0)
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/operations'))).toBe(false)
  })

  it('uses wildcard SAC topic filters and maps incoming transfers', async () => {
    const nativeSac = Asset.native().contractId(PASSPHRASE)
    const cAddressVal = new Address(C_SMART).toScVal().toXDR('base64')

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          method: string
          params?: { filters?: { topics?: string[][]; contractIds?: string[] }[] }
        }
        if (body.method === 'getLatestLedger') {
          return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
        }
        if (body.method === 'getEvents') {
          const topics = body.params?.filters?.[0]?.topics?.[0]
          expect(topics).toBeDefined()
          expect(body.params?.filters?.[0]?.contractIds).toBeUndefined()
          const isIncoming = topics?.[2] === cAddressVal
          if (isIncoming) {
            return new Response(
              JSON.stringify({
                result: {
                  events: [
                    makeTransferEvent({
                      from: SENDER,
                      to: C_SMART,
                      amountRaw: 5_000_000n,
                      txHash: 'sac-in',
                      eventId: 'evt-in',
                      ledgerClosedAt: '2024-06-01T12:00:00Z',
                      contractId: nativeSac,
                    }),
                  ],
                },
              })
            )
          }
          return new Response(JSON.stringify({ result: { events: [] } }))
        }
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchSmartAccountPayments({
      cAddress: C_SMART,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
      network: 'testnet',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.transactionHash).toBe('sac-in')
    expect(rows[0]!.amount).toBe('0.5')
    expect(rows[0]!.txType).toBe('receive')
  })

  it('shrinks SAC reach on processing-limit error then succeeds', async () => {
    let getEventsCalls = 0
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          method: string
          params?: { startLedger?: number }
        }
        if (body.method === 'getLatestLedger') {
          return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
        }
        if (body.method === 'getEvents') {
          getEventsCalls += 1
          const start = body.params?.startLedger ?? 0
          // First attempts with wide reach fail; narrower succeed.
          if (50_000 - start > 3_000) {
            return new Response(
              JSON.stringify({
                error: { message: 'request exceeded processing limit threshold' },
              })
            )
          }
          return new Response(
            JSON.stringify({
              result: {
                events: [
                  makeTransferEvent({
                    from: SENDER,
                    to: C_SMART,
                    amountRaw: 1_000_000n,
                    txHash: 'after-shrink',
                    eventId: 'evt-shrink',
                    ledgerClosedAt: '2024-06-01T12:00:00Z',
                  }),
                ],
              },
            })
          )
        }
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchSmartAccountPayments({
      cAddress: C_SMART,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
    })

    expect(getEventsCalls).toBeGreaterThan(2)
    expect(rows.some((r) => r.transactionHash === 'after-shrink')).toBe(true)
  })

  it('dedupes overlapping Horizon and SAC rows', async () => {
    const nativeSac = Asset.native().contractId(PASSPHRASE)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes(`/accounts/${G_CLASSIC}/operations`) && init?.method !== 'POST') {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  id: 'op-dup',
                  type: 'invoke_host_function',
                  transaction_hash: 'same-hash',
                  source_account: G_CLASSIC,
                  created_at: '2024-01-01T00:00:00Z',
                  asset_balance_changes: [
                    {
                      from: SENDER,
                      to: C_SMART,
                      amount: '0.5000000',
                      asset_type: 'native',
                    },
                  ],
                },
              ],
            },
          })
        )
      }
      if (u.includes('/accounts/') && !u.includes('/operations') && init?.method !== 'POST') {
        return new Response(
          JSON.stringify(horizonAccountJson([{ asset_type: 'native', balance: '1.0000000' }]))
        )
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string }
        if (body.method === 'getLatestLedger') {
          return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
        }
        return new Response(
          JSON.stringify({
            result: {
              events: [
                makeTransferEvent({
                  from: SENDER,
                  to: C_SMART,
                  amountRaw: 5_000_000n,
                  txHash: 'same-hash',
                  eventId: 'evt-dup',
                  ledgerClosedAt: '2024-01-01T00:00:00Z',
                  contractId: nativeSac,
                }),
              ],
            },
          })
        )
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchSmartAccountPayments({
      cAddress: C_SMART,
      gAddress: G_CLASSIC,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
    })

    expect(rows.filter((r) => r.transactionHash === 'same-hash')).toHaveLength(1)
  })

  it('falls back to effects when asset_balance_changes is empty', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes(`/accounts/${G_CLASSIC}/operations`) && init?.method !== 'POST') {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  id: '1',
                  type: 'invoke_host_function',
                  transaction_hash: 'hash-a',
                  source_account: G_CLASSIC,
                  created_at: '2024-01-01T00:00:00Z',
                  asset_balance_changes: [],
                },
              ],
            },
          })
        )
      }
      if (u.includes('/operations/1/effects')) {
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  type: 'contract_credited',
                  contract: C_SMART,
                  amount: '10.0000000',
                  asset_type: 'native',
                },
              ],
            },
          })
        )
      }
      if (u.includes('/accounts/') && !u.includes('/operations') && init?.method !== 'POST') {
        return new Response(
          JSON.stringify(horizonAccountJson([{ asset_type: 'native', balance: '1.0000000' }]))
        )
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string }
        if (body.method === 'getLatestLedger') {
          return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
        }
        return new Response(JSON.stringify({ result: { events: [] } }))
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchSmartAccountPayments({
      cAddress: C_SMART,
      gAddress: G_CLASSIC,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: PASSPHRASE,
    })

    expect(rows.length).toBe(1)
    expect(rows[0]!.transactionHash).toBe('hash-a')
    expect(rows[0]!.to).toBe(C_SMART)
  })

  it('throws when SAC getEvents fails instead of returning an empty feed', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { method: string }
        if (body.method === 'getLatestLedger') {
          return new Response(JSON.stringify({ result: { sequence: 50_000 } }))
        }
        return new Response('nope', { status: 500 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchSmartAccountPayments({
        cAddress: C_SMART,
        horizonUrl: 'https://horizon-testnet.stellar.org',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: PASSPHRASE,
      })
    ).rejects.toThrow(/Transaction history incomplete/)
  })
})

describe('makeTransferEvent helper', () => {
  it('encodes topics and amount for SAC transfer parsing', () => {
    const ev = makeTransferEvent({
      from: SENDER,
      to: C_SMART,
      amountRaw: 5_000_000n,
      txHash: 'tx',
      eventId: 'evt',
      ledgerClosedAt: '2024-01-01T00:00:00Z',
    })
    const topics = ev.topic as string[]
    expect(String(scValToNative(xdr.ScVal.fromXDR(topics[1]!, 'base64')))).toBe(SENDER)
    expect(String(scValToNative(xdr.ScVal.fromXDR(topics[2]!, 'base64')))).toBe(C_SMART)
    expect(scValToNative(xdr.ScVal.fromXDR(String(ev.value), 'base64'))).toBe(5_000_000n)
  })
})
