import { Asset, Keypair, Networks } from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackendError } from '../backend'
import { clearMnemonicSessionKeys, registerMnemonicKeypair } from '../mnemonicSession'
import { setCachedActiveNetwork } from '../network/config'
import { createAccount, resetAccountsPartitionMigrationForTests } from '../storage'
import { clearDiscoveryCache } from './discoveryCache'
import { runMigrationSweepToken, runMigrationSweepXlm } from './sweep'

const SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const PASSPHRASE = Networks.TESTNET

const { createRpcServer, simulateAndAssembleSoroban, sendAndPollSoroban } = vi.hoisted(() => ({
  createRpcServer: vi.fn(() => ({})),
  simulateAndAssembleSoroban: vi.fn(
    async (_rpc: unknown, unsigned: { sign: (kp: unknown) => void }) => unsigned
  ),
  sendAndPollSoroban: vi.fn(async () => ({
    status: 'SUCCESS' as const,
    hash: 'TXHASH',
    latestLedger: 42,
  })),
}))

vi.mock('@latch/stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@latch/stellar')>()
  return {
    ...actual,
    createRpcServer,
    simulateAndAssembleSoroban,
    sendAndPollSoroban,
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function horizonAccount(args: {
  id: string
  sequence?: string
  subentry_count?: number
  balances: unknown[]
}) {
  return {
    id: args.id,
    sequence: args.sequence ?? '1',
    subentry_count: args.subentry_count ?? 0,
    balances: args.balances,
  }
}

describe('migration sweep helpers', () => {
  beforeEach(() => {
    resetAccountsPartitionMigrationForTests()
    setCachedActiveNetwork('testnet')
    clearDiscoveryCache()
    clearMnemonicSessionKeys()
    createRpcServer.mockClear()
    simulateAndAssembleSoroban.mockClear()
    sendAndPollSoroban.mockClear()
    sendAndPollSoroban.mockResolvedValue({
      status: 'SUCCESS',
      hash: 'TXHASH',
      latestLedger: 42,
    })
    simulateAndAssembleSoroban.mockImplementation(async (_rpc, unsigned) => unsigned)
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    clearMnemonicSessionKeys()
    vi.unstubAllGlobals()
  })

  describe('runMigrationSweepXlm', () => {
    it('sweeps native XLM successfully', async () => {
      const kp = Keypair.random()
      const g = kp.publicKey()
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })
      registerMnemonicKeypair(account.id, kp)

      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(
          horizonAccount({
            id: g,
            balances: [{ asset_type: 'native', balance: '100.0000000' }],
          })
        )
      )

      const result = await runMigrationSweepXlm(account.id, 0)
      expect(result).toEqual({ success: true, txHash: 'TXHASH', ledger: 42 })
      expect(simulateAndAssembleSoroban).toHaveBeenCalled()
      expect(sendAndPollSoroban).toHaveBeenCalled()
    })

    it('returns missing_addresses when G or C is absent', async () => {
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
      })
      const result = await runMigrationSweepXlm(account.id)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('missing_addresses')
    })

    it('returns not_mnemonic for passkey accounts', async () => {
      const g = Keypair.random().publicKey()
      const { account } = await createAccount({
        mode: 'passkey',
        smartAccountAddress: SMART,
        gAddress: g,
        passkeyCredentialId: 'cred',
        passkeyKeyDataHex: 'aa',
      })
      const result = await runMigrationSweepXlm(account.id)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('not_mnemonic')
    })

    it('throws mnemonic_locked when the seed signer is not loaded', async () => {
      const g = Keypair.random().publicKey()
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })

      await expect(runMigrationSweepXlm(account.id)).rejects.toMatchObject({
        name: 'BackendError',
        code: 'mnemonic_locked',
      } satisfies Partial<BackendError>)
    })

    it('returns insufficient_xlm when balance cannot cover reserve and fees', async () => {
      const kp = Keypair.random()
      const g = kp.publicKey()
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })
      registerMnemonicKeypair(account.id, kp)

      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(
          horizonAccount({
            id: g,
            balances: [{ asset_type: 'native', balance: '1.5000000' }],
          })
        )
      )

      const result = await runMigrationSweepXlm(account.id, 0)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('insufficient_xlm')
    })

    it('returns simulation_failed when assemble throws', async () => {
      const kp = Keypair.random()
      const g = kp.publicKey()
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })
      registerMnemonicKeypair(account.id, kp)

      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(
          horizonAccount({
            id: g,
            balances: [{ asset_type: 'native', balance: '100.0000000' }],
          })
        )
      )
      simulateAndAssembleSoroban.mockRejectedValueOnce(new Error('sim blew up'))

      const result = await runMigrationSweepXlm(account.id, 0)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('simulation_failed')
      expect(result.error?.message).toMatch(/sim blew up/)
    })

    it('returns tx_failed when Soroban send fails', async () => {
      const kp = Keypair.random()
      const g = kp.publicKey()
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })
      registerMnemonicKeypair(account.id, kp)

      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(
          horizonAccount({
            id: g,
            balances: [{ asset_type: 'native', balance: '100.0000000' }],
          })
        )
      )
      sendAndPollSoroban.mockResolvedValueOnce({
        status: 'FAILED',
        hash: 'BADHASH',
        error: 'on-chain fail',
        confirmationTimedOut: false,
        latestLedger: 1,
      })

      const result = await runMigrationSweepXlm(account.id, 0)
      expect(result.success).toBe(false)
      expect(result.txHash).toBe('BADHASH')
      expect(result.error?.code).toBe('tx_failed')
    })
  })

  describe('runMigrationSweepToken', () => {
    it('sweeps a matching trustline successfully', async () => {
      const kp = Keypair.random()
      const g = kp.publicKey()
      const issuer = Keypair.random().publicKey()
      const sacContractId = new Asset('USDC', issuer).contractId(PASSPHRASE)
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })
      registerMnemonicKeypair(account.id, kp)

      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(
          horizonAccount({
            id: g,
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

      const result = await runMigrationSweepToken(account.id, sacContractId)
      expect(result).toEqual({ success: true, txHash: 'TXHASH', ledger: 42 })
    })

    it('returns insufficient_xlm_fee when XLM cannot cover the Soroban fee', async () => {
      const kp = Keypair.random()
      const g = kp.publicKey()
      const issuer = Keypair.random().publicKey()
      const sacContractId = new Asset('USDC', issuer).contractId(PASSPHRASE)
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })
      registerMnemonicKeypair(account.id, kp)

      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(
          horizonAccount({
            id: g,
            subentry_count: 1,
            balances: [
              { asset_type: 'native', balance: '1.5000000' },
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

      const result = await runMigrationSweepToken(account.id, sacContractId)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('insufficient_xlm_fee')
    })

    it('returns no_trustline when the SAC id does not match', async () => {
      const kp = Keypair.random()
      const g = kp.publicKey()
      const issuer = Keypair.random().publicKey()
      const otherSac = Asset.native().contractId(PASSPHRASE)
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })
      registerMnemonicKeypair(account.id, kp)

      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(
          horizonAccount({
            id: g,
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

      const result = await runMigrationSweepToken(account.id, otherSac)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('no_trustline')
    })

    it('returns zero_balance when the trustline balance is empty', async () => {
      const kp = Keypair.random()
      const g = kp.publicKey()
      const issuer = Keypair.random().publicKey()
      const sacContractId = new Asset('USDC', issuer).contractId(PASSPHRASE)
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress: g,
      })
      registerMnemonicKeypair(account.id, kp)

      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(
          horizonAccount({
            id: g,
            subentry_count: 1,
            balances: [
              { asset_type: 'native', balance: '10.0000000' },
              {
                asset_type: 'credit_alphanum4',
                asset_code: 'USDC',
                asset_issuer: issuer,
                balance: '0.0000000',
              },
            ],
          })
        )
      )

      const result = await runMigrationSweepToken(account.id, sacContractId)
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('zero_balance')
    })
  })
})
