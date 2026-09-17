import type {
  AccountSignerRecord,
  AttachBackupPasskeyRequest,
  BackgroundMessage,
  ExecuteAddBackupSignerRequest,
  ExecuteRemoveAccountSignerRequest,
  ListAccountSignersRequest,
  StoredAccount,
} from '@latch/types'

import { attachPasskeySigner } from '../api/webauthn'
import { finishOutcome } from '../confirm/finishOutcome'
import type { OkFn } from '../messageResponse'
import { getAccountSignerRecords, getAccounts, upsertAccountSignerRecord } from '../storage'
import { executeAddBackupSignerInBackground } from './addBackupSigner'
import { executeRemoveAccountSignerInBackground } from './removeAccountSigner'

/**
 * The account a signer message targets: an explicit address when the UI sends
 * one, otherwise the active account. Passkey-only — a seed-backed or multisig
 * wallet has no WebAuthn signer set to manage here.
 */
async function resolveSignerAccount(smartAccountAddress?: string): Promise<StoredAccount> {
  const { accounts, activeAccountId } = await getAccounts()
  const wanted = smartAccountAddress?.trim()
  const account = wanted
    ? accounts.find((a) => a.smartAccountAddress === wanted)
    : accounts.find((a) => a.id === activeAccountId)
  if (!account) throw new Error('Account not found.')
  if (account.mode !== 'passkey') {
    throw new Error('Only passkey wallets have backup signers.')
  }
  return account
}

/**
 * Signers as this install knows them: the credential it signs with, plus any
 * backup credentials it attached. There is no server-side list to reconcile
 * against — `GET /api/accounts` deliberately excludes signers.
 */
async function listSigners(account: StoredAccount): Promise<AccountSignerRecord[]> {
  const stored = await getAccountSignerRecords(account.smartAccountAddress)
  const primaryCredentialId = account.passkeyCredentialId?.trim()
  const backups = stored.filter((s) => s.credentialId !== primaryCredentialId)
  if (!primaryCredentialId) return backups

  const primary: AccountSignerRecord = {
    credentialId: primaryCredentialId,
    keyDataHex: account.passkeyKeyDataHex,
    label: account.label,
    role: 'primary',
    status: 'onchain',
    addedAt: account.createdAt,
  }
  return [primary, ...backups]
}

/** Returns true if the message type was handled. */
export async function tryHandleSignersMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
): Promise<boolean> {
  switch (message.type) {
    case 'LIST_ACCOUNT_SIGNERS': {
      const req = (message.payload ?? {}) as ListAccountSignersRequest
      const account = await resolveSignerAccount(req.smartAccountAddress)
      sendResponse(
        ok({
          smartAccountAddress: account.smartAccountAddress,
          signers: await listSigners(account),
        })
      )
      return true
    }

    case 'ATTACH_BACKUP_PASSKEY': {
      const req = message.payload as AttachBackupPasskeyRequest
      const account = await resolveSignerAccount(req.smartAccountAddress)
      const attached = await attachPasskeySigner(account.smartAccountAddress, {
        response: req.response,
        displayName: req.displayName,
        seq: req.seq,
      })
      // Pending until `add_signer` settles: attaching records the credential
      // but authorizes nothing on-chain.
      const signer: AccountSignerRecord = {
        credentialId: attached.credentialId,
        keyDataHex: attached.keyDataHex,
        label: req.displayName,
        seq: req.seq,
        role: 'backup',
        status: 'pending',
        addedAt: Date.now(),
      }
      await upsertAccountSignerRecord(account.smartAccountAddress, signer)
      sendResponse(ok({ smartAccountAddress: account.smartAccountAddress, signer }))
      return true
    }

    case 'EXECUTE_ADD_BACKUP_SIGNER': {
      const req = message.payload as ExecuteAddBackupSignerRequest
      const account = await resolveSignerAccount(req.smartAccountAddress)
      try {
        const data = await executeAddBackupSignerInBackground({ activeAccount: account, req })
        await finishOutcome({ surface: req.surface, kind: 'accountSigners', status: 'success' })
        sendResponse(ok(data))
      } catch (e) {
        await finishOutcome({
          surface: req.surface,
          kind: 'accountSigners',
          status: 'failure',
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
      return true
    }

    case 'EXECUTE_REMOVE_ACCOUNT_SIGNER': {
      const req = message.payload as ExecuteRemoveAccountSignerRequest
      const account = await resolveSignerAccount(req.smartAccountAddress)
      try {
        const data = await executeRemoveAccountSignerInBackground({ activeAccount: account, req })
        await finishOutcome({ surface: req.surface, kind: 'accountSigners', status: 'success' })
        sendResponse(ok(data))
      } catch (e) {
        await finishOutcome({
          surface: req.surface,
          kind: 'accountSigners',
          status: 'failure',
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
      return true
    }

    default:
      return false
  }
}
