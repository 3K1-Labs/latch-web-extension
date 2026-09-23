import { Asset, Keypair, Networks } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BackendError } from '../backend'
import { setCachedActiveNetwork } from '../network/config'
import { createAccount, resetAccountsPartitionMigrationForTests } from '../storage'
import { clearDiscoveryCache } from './discoveryCache'
import { runMigrationDiscover } from './discover'

const SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('runMigrationDiscover', () => {
  beforeEach(async () => {
    resetAccountsPartitionMigrationForTests()
    setCachedActiveNetwork('testnet')
    clearDiscoveryCache()
    vi.restoreAllMocks()
  })

  it('returns not_started when Horizon shows migrable native XLM', async () => {
    const g = Keypair.random().publicKey()
    const { account } = await createAccount({
      mode: 'mnemonic',
      smartAccountAddress: SMART,
      gAddress: g,
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: g,
          sequence: '1',
          subentry_count: 0,
          balances: [{ asset_type: 'native', balance: '5.0000000' }],
        })
      )
    )

    const result = await runMigrationDiscover(account.id)
    expect(result.state).toBe('not_started')
    expect(result.gAddress).toBe(g)
    expect(result.cAddress).toBe(SMART)
    expect(result.assets.some((a) => a.kind === 'native' && a.code === 'XLM')).toBe(true)
  })

  it('returns not_needed when Horizon returns 404', async () => {
    const g = Keypair.random().publicKey()
    const { account } = await createAccount({
      mode: 'mnemonic',
      smartAccountAddress: SMART,
      gAddress: g,
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    )

    const result = await runMigrationDiscover(account.id)
    expect(result).toEqual({
      state: 'not_needed',
      gAddress: g,
      cAddress: SMART,
      assets: [],
    })
  })

  it('returns complete when only reserve XLM remains', async () => {
    const g = Keypair.random().publicKey()
    const { account } = await createAccount({
      mode: 'mnemonic',
      smartAccountAddress: SMART,
      gAddress: g,
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: g,
          sequence: '1',
          subentry_count: 0,
          balances: [{ asset_type: 'native', balance: '1.0000000' }],
        })
      )
    )

    const result = await runMigrationDiscover(account.id)
    expect(result.state).toBe('complete')
    expect(result.assets).toEqual([])
  })

  it('throws BackendError no_account for an unknown account id', async () => {
    await expect(runMigrationDiscover('missing-id')).rejects.toMatchObject({
      name: 'BackendError',
      code: 'no_account',
    } satisfies Partial<BackendError>)
  })

  it('returns unsupported when G or C address is missing', async () => {
    const { account } = await createAccount({
      mode: 'mnemonic',
      smartAccountAddress: SMART,
      // no gAddress
    })

    const result = await runMigrationDiscover(account.id)
    expect(result.state).toBe('unsupported')
    expect(result.unsupportedReason).toBe('missing_addresses')
    expect(result.assets).toEqual([])
  })

  it('returns unsupported for passkey accounts', async () => {
    const g = Keypair.random().publicKey()
    const { account } = await createAccount({
      mode: 'passkey',
      smartAccountAddress: SMART,
      gAddress: g,
      passkeyCredentialId: 'cred',
      passkeyKeyDataHex: 'deadbeef',
    })

    const result = await runMigrationDiscover(account.id)
    expect(result.state).toBe('unsupported')
    expect(result.unsupportedReason).toBe('not_mnemonic')
  })

  it('throws when Horizon returns a non-OK status', async () => {
    const g = Keypair.random().publicKey()
    const { account } = await createAccount({
      mode: 'mnemonic',
      smartAccountAddress: SMART,
      gAddress: g,
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('fail', { status: 500 }))
    )

    await expect(runMigrationDiscover(account.id)).rejects.toThrow(
      /Horizon account fetch failed: HTTP 500/
    )
  })

  it('throws when Horizon JSON is unparsable as an account', async () => {
    const g = Keypair.random().publicKey()
    const { account } = await createAccount({
      mode: 'mnemonic',
      smartAccountAddress: SMART,
      gAddress: g,
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ not: 'an account' }))
    )

    await expect(runMigrationDiscover(account.id)).rejects.toThrow(
      /Unexpected Horizon account JSON/
    )
  })

  it('includes trustline SAC ids on not_started discovery', async () => {
    const g = Keypair.random().publicKey()
    const issuer = Keypair.random().publicKey()
    const { account } = await createAccount({
      mode: 'mnemonic',
      smartAccountAddress: SMART,
      gAddress: g,
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: g,
          sequence: '1',
          subentry_count: 1,
          balances: [
            { asset_type: 'native', balance: '10.0000000' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: issuer,
              balance: '25.0000000',
            },
          ],
        })
      )
    )

    const result = await runMigrationDiscover(account.id)
    expect(result.state).toBe('not_started')
    const usdc = result.assets.find((a) => a.code === 'USDC')
    expect(usdc?.kind).toBe('token')
    expect(usdc?.sacContractId).toBe(new Asset('USDC', issuer).contractId(Networks.TESTNET))
  })
})
