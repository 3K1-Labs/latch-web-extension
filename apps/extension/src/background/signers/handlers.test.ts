import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AccountSignerRecord, BackgroundMessage, StoredAccount } from '@latch/types'

const addAccountSigner = vi.fn()
const confirmAddAccountSigner = vi.fn()
const removeAccountSigner = vi.fn()
const confirmRemoveAccountSigner = vi.fn()

vi.mock('../api/accountSigners', () => ({
  addAccountSigner: (...args: unknown[]) => addAccountSigner(...args),
  confirmAddAccountSigner: (...args: unknown[]) => confirmAddAccountSigner(...args),
  removeAccountSigner: (...args: unknown[]) => removeAccountSigner(...args),
  confirmRemoveAccountSigner: (...args: unknown[]) => confirmRemoveAccountSigner(...args),
}))

const attachPasskeySigner = vi.fn()

vi.mock('../api/webauthn', () => ({
  attachPasskeySigner: (...args: unknown[]) => attachPasskeySigner(...args),
}))

const signAndSubmitBuiltTxInBackground = vi.fn()

vi.mock('../tx/signBuiltTx', () => ({
  signAndSubmitBuiltTxInBackground: (...args: unknown[]) =>
    signAndSubmitBuiltTxInBackground(...args),
}))

const finishOutcome = vi.fn()

vi.mock('../confirm/finishOutcome', () => ({
  finishOutcome: (...args: unknown[]) => finishOutcome(...args),
}))

const account: StoredAccount = {
  id: 'acct-1',
  mode: 'passkey',
  smartAccountAddress: 'CWALLET',
  passkeyCredentialId: 'cred-a',
  passkeyKeyDataHex: 'aa',
  label: 'Savings',
  createdAt: 5,
}

let storedSigners: AccountSignerRecord[] = []

const getAccounts = vi.fn(async () => ({ accounts: [account], activeAccountId: account.id }))
const getAccountSignerRecords = vi.fn(async () => storedSigners)
const upsertAccountSignerRecord = vi.fn(async (_address: string, record: AccountSignerRecord) => {
  storedSigners = [...storedSigners.filter((s) => s.credentialId !== record.credentialId), record]
  return storedSigners
})
const deleteAccountSignerRecord = vi.fn(async (_address: string, credentialId: string) => {
  storedSigners = storedSigners.filter((s) => s.credentialId !== credentialId)
  return storedSigners
})

vi.mock('../storage', () => ({
  getAccounts: (...args: unknown[]) => getAccounts(...(args as [])),
  getAccountSignerRecords: (...args: unknown[]) =>
    getAccountSignerRecords(...(args as [] as never)),
  upsertAccountSignerRecord: (address: string, record: AccountSignerRecord) =>
    upsertAccountSignerRecord(address, record),
  deleteAccountSignerRecord: (address: string, credentialId: string) =>
    deleteAccountSignerRecord(address, credentialId),
}))

import { BackendError } from '../api/client'
import { tryHandleSignersMessage } from './handlers'

const ok = <T>(data?: T) => ({ ok: true as const, data })

function send<T = unknown>(): {
  fn: (response: unknown) => void
  result: () => { ok: true; data?: T }
} {
  let captured: unknown
  return {
    fn: (response: unknown) => {
      captured = response
    },
    result: () => captured as { ok: true; data?: T },
  }
}

const build = {
  txXdr: 'xdr',
  contextRuleId: 4,
  smartAccountAuthEntryXdr: 'auth',
}

describe('tryHandleSignersMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storedSigners = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false for unrelated message types', async () => {
    const res = send()
    expect(
      await tryHandleSignersMessage(
        { type: 'GET_ACCOUNTS', payload: undefined } as BackgroundMessage,
        res.fn,
        ok
      )
    ).toBe(false)
  })

  it('lists the active credential as primary alongside stored backups', async () => {
    storedSigners = [
      {
        credentialId: 'cred-b',
        role: 'backup',
        status: 'onchain',
        signerId: 9,
        addedAt: 20,
      },
    ]

    const res = send<{ signers: AccountSignerRecord[] }>()
    await tryHandleSignersMessage(
      { type: 'LIST_ACCOUNT_SIGNERS', payload: undefined } as BackgroundMessage,
      res.fn,
      ok
    )

    const signers = res.result().data!.signers
    expect(signers.map((s) => [s.credentialId, s.role])).toEqual([
      ['cred-a', 'primary'],
      ['cred-b', 'backup'],
    ])
    expect(signers[0]!.label).toBe('Savings')
  })

  it('records an attached passkey as pending, since nothing is on-chain yet', async () => {
    attachPasskeySigner.mockResolvedValue({
      credentialId: 'cred-b',
      keyDataHex: 'bb',
      smartAccountAddress: 'CWALLET',
    })

    const res = send<{ signer: AccountSignerRecord }>()
    await tryHandleSignersMessage(
      {
        type: 'ATTACH_BACKUP_PASSKEY',
        payload: { response: {}, displayName: 'Backup (Latch 2) · backup', seq: 2 },
      } as BackgroundMessage,
      res.fn,
      ok
    )

    expect(res.result().data!.signer.status).toBe('pending')
    expect(storedSigners).toHaveLength(1)
  })

  it('signs, submits and confirms an add, then marks the signer on-chain', async () => {
    storedSigners = [
      { credentialId: 'cred-b', keyDataHex: 'bb', role: 'backup', status: 'pending', addedAt: 20 },
    ]
    addAccountSigner.mockResolvedValue(build)
    signAndSubmitBuiltTxInBackground.mockResolvedValue({ transactionHash: 'hash-1' })
    confirmAddAccountSigner.mockResolvedValue({ confirmed: true, signerId: 12 })

    const res = send<{ signer: AccountSignerRecord }>()
    await tryHandleSignersMessage(
      {
        type: 'EXECUTE_ADD_BACKUP_SIGNER',
        payload: { credentialId: 'cred-b', surface: 'popup' },
      } as BackgroundMessage,
      res.fn,
      ok
    )

    expect(confirmAddAccountSigner).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: 'hash-1', contextRuleId: 4, credentialId: 'cred-b' })
    )
    const signer = res.result().data!.signer
    expect(signer.status).toBe('onchain')
    expect(signer.signerId).toBe(12)
    expect(signer.pendingConfirm).toBeUndefined()
    expect(finishOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'accountSigners', status: 'success' })
    )
  })

  it('skips the transaction when the signer is already configured', async () => {
    storedSigners = [
      { credentialId: 'cred-b', keyDataHex: 'bb', role: 'backup', status: 'pending', addedAt: 20 },
    ]
    addAccountSigner.mockResolvedValue({ alreadyConfigured: true, message: 'already a signer' })

    const res = send<{ alreadyConfigured?: boolean; signer: AccountSignerRecord }>()
    await tryHandleSignersMessage(
      {
        type: 'EXECUTE_ADD_BACKUP_SIGNER',
        payload: { credentialId: 'cred-b' },
      } as BackgroundMessage,
      res.fn,
      ok
    )

    expect(signAndSubmitBuiltTxInBackground).not.toHaveBeenCalled()
    expect(confirmAddAccountSigner).not.toHaveBeenCalled()
    expect(res.result().data!.alreadyConfigured).toBe(true)
    expect(res.result().data!.signer.status).toBe('onchain')
  })

  it('retries confirm while the transaction has not settled', async () => {
    vi.useFakeTimers()
    storedSigners = [
      { credentialId: 'cred-b', keyDataHex: 'bb', role: 'backup', status: 'pending', addedAt: 20 },
    ]
    addAccountSigner.mockResolvedValue(build)
    signAndSubmitBuiltTxInBackground.mockResolvedValue({ hash: 'hash-2' })
    confirmAddAccountSigner
      .mockRejectedValueOnce(
        new BackendError('transaction has not settled', { status: 400, code: 'validation_error' })
      )
      .mockResolvedValueOnce({ confirmed: true, signerId: 3 })

    const res = send<{ signer: AccountSignerRecord }>()
    const handled = tryHandleSignersMessage(
      {
        type: 'EXECUTE_ADD_BACKUP_SIGNER',
        payload: { credentialId: 'cred-b' },
      } as BackgroundMessage,
      res.fn,
      ok
    )
    await vi.runAllTimersAsync()
    await handled
    vi.useRealTimers()

    expect(confirmAddAccountSigner).toHaveBeenCalledTimes(2)
    expect(res.result().data!.signer.signerId).toBe(3)
  })

  it('keeps the signer pending with its hash when confirm ultimately fails', async () => {
    vi.useFakeTimers()
    storedSigners = [
      { credentialId: 'cred-b', keyDataHex: 'bb', role: 'backup', status: 'pending', addedAt: 20 },
    ]
    addAccountSigner.mockResolvedValue(build)
    signAndSubmitBuiltTxInBackground.mockResolvedValue({ transactionHash: 'hash-3' })
    confirmAddAccountSigner.mockRejectedValue(
      new BackendError('transaction has not settled', { status: 400, code: 'validation_error' })
    )

    const res = send()
    const handled = tryHandleSignersMessage(
      {
        type: 'EXECUTE_ADD_BACKUP_SIGNER',
        payload: { credentialId: 'cred-b', surface: 'popup' },
      } as BackgroundMessage,
      res.fn,
      ok
    ).catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const thrown = await handled
    vi.useRealTimers()

    expect(thrown).toBeInstanceOf(BackendError)
    expect(storedSigners[0]!.status).toBe('pending')
    expect(storedSigners[0]!.pendingConfirm).toEqual({ txHash: 'hash-3', contextRuleId: 4 })
    expect(finishOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'accountSigners', status: 'failure' })
    )
  })

  it('resumes from a stored pendingConfirm without rebuilding the transaction', async () => {
    storedSigners = [
      {
        credentialId: 'cred-b',
        keyDataHex: 'bb',
        role: 'backup',
        status: 'pending',
        addedAt: 20,
        pendingConfirm: { txHash: 'hash-4', contextRuleId: 6 },
      },
    ]
    confirmAddAccountSigner.mockResolvedValue({ confirmed: true, signerId: 8 })

    const res = send<{ signer: AccountSignerRecord }>()
    await tryHandleSignersMessage(
      {
        type: 'EXECUTE_ADD_BACKUP_SIGNER',
        payload: { credentialId: 'cred-b', resumeConfirmOnly: true },
      } as BackgroundMessage,
      res.fn,
      ok
    )

    expect(addAccountSigner).not.toHaveBeenCalled()
    expect(signAndSubmitBuiltTxInBackground).not.toHaveBeenCalled()
    expect(confirmAddAccountSigner).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: 'hash-4', contextRuleId: 6 })
    )
    expect(res.result().data!.signer.status).toBe('onchain')
  })

  it('does not record a signer when the chain call fails', async () => {
    storedSigners = []
    addAccountSigner.mockRejectedValue(
      new BackendError('not a signer', { status: 403, code: 'not_a_signer' })
    )

    const res = send()
    const thrown = await tryHandleSignersMessage(
      {
        type: 'EXECUTE_ADD_BACKUP_SIGNER',
        payload: { credentialId: 'cred-b', keyDataHex: 'bb' },
      } as BackgroundMessage,
      res.fn,
      ok
    ).catch((e: unknown) => e)

    expect(thrown).toBeInstanceOf(BackendError)
    expect(storedSigners).toEqual([])
  })

  it('drops the local record only after removal is confirmed', async () => {
    storedSigners = [
      { credentialId: 'cred-b', keyDataHex: 'bb', role: 'backup', status: 'onchain', addedAt: 20 },
    ]
    removeAccountSigner.mockResolvedValue({ ...build, signerId: 12 })
    signAndSubmitBuiltTxInBackground.mockResolvedValue({ transactionHash: 'hash-5' })
    confirmRemoveAccountSigner.mockResolvedValue({ confirmed: true, signerId: 12 })

    const res = send<{ credentialId: string }>()
    await tryHandleSignersMessage(
      {
        type: 'EXECUTE_REMOVE_ACCOUNT_SIGNER',
        payload: { credentialId: 'cred-b' },
      } as BackgroundMessage,
      res.fn,
      ok
    )

    expect(res.result().data!.credentialId).toBe('cred-b')
    expect(storedSigners).toEqual([])
  })

  it('refuses to remove the credential this device signs with', async () => {
    const res = send()
    const thrown = await tryHandleSignersMessage(
      {
        type: 'EXECUTE_REMOVE_ACCOUNT_SIGNER',
        payload: { credentialId: 'cred-a' },
      } as BackgroundMessage,
      res.fn,
      ok
    ).catch((e: unknown) => e)

    expect((thrown as Error).message).toMatch(/passkey this device signs with/)
    expect(removeAccountSigner).not.toHaveBeenCalled()
  })
})
