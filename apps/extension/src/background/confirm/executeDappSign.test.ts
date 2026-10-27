import {
  Account,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import type { BuildSendTxResponse, ExternalSignLocalReview } from '@latch/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OTHER_CONTRACT, authEntryXdr } from '../../test/authEntry'
import {
  getDappRequest,
  resetDappRequestStateForTests,
  upsertDappRequest,
} from '../dapp/requestState'

const signAndSubmit = vi.fn()
const getAccounts = vi.fn()

vi.mock('../tx/signBuiltTx', () => ({
  signAndSubmitBuiltTxInBackground: (...args: unknown[]) => signAndSubmit(...args),
}))
vi.mock('../storage', () => ({ getAccounts: () => getAccounts() }))
vi.mock('../network/config', () => ({
  getActiveNetwork: vi.fn(async () => 'testnet' as const),
  networkPassphraseFor: () => Networks.TESTNET,
  feeForwarderContractIdFor: () => undefined,
}))
vi.mock('../dapp/approvalSession', async () => {
  const state = await import('../dapp/requestState')
  return {
    resolveDappRequestDecision: vi.fn(
      async (req: Parameters<typeof state.resolveDappRequest>[0]) => {
        const { record } = await state.resolveDappRequest(req)
        return record
      }
    ),
    closeApprovalWindowForOrigin: vi.fn(async () => {}),
  }
})

import { executeDappExternalSignInBackground } from './executeDappSign'

const SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const ID = 'req-1'

function invokeXdr(contractId: string, fn: string): string {
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(contractId).call(fn, nativeToScVal(1, { type: 'u32' })))
    .setTimeout(30)
    .build()
    .toXDR()
}

const DAPP_TX = invokeXdr(OTHER_CONTRACT, 'swap')

function preparedWith(authEntries: string[], txXdr = DAPP_TX) {
  return {
    txXdr,
    authEntryXdr: authEntries[0]!,
    authEntriesXdr: authEntries,
    authDigestHex: 'deadbeef',
    contextRuleId: 1,
    validUntilLedger: 100,
    network: 'testnet' as const,
    smartAccountAddress: SMART,
  }
}

const BENIGN = authEntryXdr(SMART, { contractId: OTHER_CONTRACT, fn: 'swap' })
const SELF_CALL = authEntryXdr(SMART, {
  contractId: OTHER_CONTRACT,
  fn: 'swap',
  subs: [{ contractId: SMART, fn: 'batch_add_signer' }],
})
const OK_REVIEW: ExternalSignLocalReview = {
  operations: [],
  invokeContractIds: [],
  confirmBlocked: false,
  confirmBlockedReason: null,
}

async function seed(
  overrides: {
    prepared?: ReturnType<typeof preparedWith>
    localReview?: ExternalSignLocalReview
    status?: 'awaiting_user' | 'rejected'
    unsignedTxXdr?: string
    smartAccountAddress?: string
  } = {}
) {
  await upsertDappRequest(
    {
      id: ID,
      origin: 'https://dapp.example',
      kind: 'externalSignReview',
      createdAt: Date.now(),
      signRequest: {
        network: 'testnet',
        smartAccountAddress: overrides.smartAccountAddress ?? SMART,
        unsignedTxXdr: overrides.unsignedTxXdr ?? DAPP_TX,
      },
      prepared: overrides.prepared ?? preparedWith([BENIGN]),
      localReview: overrides.localReview,
      source: 'provider',
    },
    overrides.status ?? 'awaiting_user'
  )
}

const run = (prepared: BuildSendTxResponse = preparedWith([BENIGN])) =>
  executeDappExternalSignInBackground({ requestId: ID, accountId: 'acc-1', prepared, submit: true })

describe('executeDappExternalSignInBackground', () => {
  beforeEach(async () => {
    signAndSubmit.mockReset()
    signAndSubmit.mockResolvedValue({ transactionHash: 'hash-1' })
    getAccounts.mockReset()
    getAccounts.mockResolvedValue({
      accounts: [{ id: 'acc-1', mode: 'passkey', smartAccountAddress: SMART }],
      activeAccountId: 'acc-1',
    })
    resetDappRequestStateForTests()
  })

  it('signs the stored build exactly once and resolves the request', async () => {
    const prepared = preparedWith([BENIGN])
    await seed({ prepared, localReview: OK_REVIEW })

    await run(prepared)

    expect(signAndSubmit).toHaveBeenCalledTimes(1)
    expect(signAndSubmit.mock.calls[0]![0].build).toMatchObject({ txXdr: prepared.txXdr })
    expect((await getDappRequest(ID))?.status).toBe('approved')
  })

  it('reviews a request stored without a local review before signing it', async () => {
    await seed()
    await run()
    expect(signAndSubmit).toHaveBeenCalledTimes(1)
  })

  it('refuses a stored build whose auth tree calls the wallet itself, before any signer runs', async () => {
    await seed({ prepared: preparedWith([SELF_CALL]), localReview: OK_REVIEW })

    await expect(run()).rejects.toThrow(/wallet's own settings/)

    expect(signAndSubmit).not.toHaveBeenCalled()
    expect(await getDappRequest(ID)).toMatchObject({
      status: 'rejected',
      errorCode: 'self_admin_call',
    })
  })

  it('refuses a dApp transaction that targets the wallet directly', async () => {
    const direct = invokeXdr(SMART, 'add_signer')
    await seed({
      unsignedTxXdr: direct,
      prepared: preparedWith([BENIGN], direct),
      localReview: OK_REVIEW,
    })

    await expect(run()).rejects.toThrow()
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('signs the stored build, not the one the UI message carries', async () => {
    const stored = preparedWith([BENIGN])
    await seed({ prepared: stored, localReview: OK_REVIEW })
    const crafted = preparedWith([SELF_CALL], invokeXdr(SMART, 'add_signer'))

    await run(crafted)

    expect(signAndSubmit).toHaveBeenCalledTimes(1)
    expect(signAndSubmit.mock.calls[0]![0].build.txXdr).toBe(stored.txXdr)
  })

  it('refuses when the stored review already blocked Confirm', async () => {
    await seed({
      localReview: {
        ...OK_REVIEW,
        confirmBlocked: true,
        confirmBlockedReason: 'blocked by review',
        code: 'contract_mismatch',
      },
    })

    await expect(run()).rejects.toThrow('blocked by review')

    expect(signAndSubmit).not.toHaveBeenCalled()
    expect(await getDappRequest(ID)).toMatchObject({
      status: 'rejected',
      errorCode: 'contract_mismatch',
    })
  })

  it('refuses when the active wallet is not the one the request was prepared for', async () => {
    await seed({ smartAccountAddress: OTHER_CONTRACT, localReview: OK_REVIEW })
    await expect(run()).rejects.toThrow()
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('does not sign a request that does not exist', async () => {
    await expect(run()).rejects.toThrow(/no longer available/)
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('does not sign a request that is no longer awaiting the user', async () => {
    await seed({ status: 'rejected', localReview: OK_REVIEW })
    await expect(run()).rejects.toThrow(/already handled/)
    expect(signAndSubmit).not.toHaveBeenCalled()
  })

  it('still reports a signer failure as sign_failed', async () => {
    await seed({ localReview: OK_REVIEW })
    signAndSubmit.mockRejectedValue(new Error('boom'))

    await expect(run()).rejects.toThrow('boom')

    expect(await getDappRequest(ID)).toMatchObject({ status: 'rejected', errorCode: 'sign_failed' })
  })
})
