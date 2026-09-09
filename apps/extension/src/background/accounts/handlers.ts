import type {
  BackgroundMessage,
  BackendWebauthnAuthenticationFinishRequest,
  BackendWebauthnRegistrationFinishRequest,
  CreateOrConnectPasskeyRequest,
  DeleteAccountRequest,
  DeleteAccountResponse,
  GetAccountsResponse,
  ImportMnemonicAccountRequest,
  SetActiveAccountRequest,
  SetSetupStateRequest,
  UnlockMnemonicVaultRequest,
} from '@latch/types'

import { ensureSetupStateMatchesAccounts, getSetupState, setSetupState } from '../actionBehavior'
import { BackendError } from '../api/client'
import {
  clearLatchApiSession,
  createOrConnectPasskey,
  ensureFreighterSmartAccountDeployed,
  getBackendAccounts,
  passkeyAuthenticationBegin,
  passkeyAuthenticationFinish,
  passkeyRegistrationBegin,
  passkeyRegistrationFinish,
} from '../backend'
import { broadcastActiveAccountChanged } from '../dappProviderEvents'
import type { OkFn } from '../messageResponse'
import {
  clearMnemonicSessionKeyForAccount,
  clearMnemonicSessionKeys,
  getMnemonicKeypair,
  registerMnemonicKeypair,
} from '../mnemonicSession'
import {
  decryptMnemonicFromVault,
  encryptMnemonicForVault,
  loadMnemonicVaultRecord,
  saveMnemonicVaultRecord,
} from '../mnemonicVault'
import { deriveStellarKeypairFromMnemonic } from '../stellarMnemonic'
import {
  createAccount,
  deleteAccount,
  disconnectSessionForLogoutDev,
  getAccounts,
  removeRemovedAccountAddress,
  renameAccount,
  setActiveAccount,
} from '../storage'

/** Returns true if the message type was handled. */
export async function tryHandleAccountsMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
): Promise<boolean> {
  switch (message.type) {
    case 'GET_SETUP_STATE': {
      await ensureSetupStateMatchesAccounts()
      const data = await getSetupState()
      sendResponse(ok(data))
      return true
    }

    case 'SET_SETUP_STATE': {
      await setSetupState(message.payload as SetSetupStateRequest)
      sendResponse(ok())
      return true
    }

    case 'LOGOUT': {
      clearMnemonicSessionKeys()
      // Without this the API `sid` cookie outlives logout, so the next call is
      // still the same session user and re-imports their whole account list.
      await clearLatchApiSession()
      await disconnectSessionForLogoutDev()
      await ensureSetupStateMatchesAccounts()
      sendResponse(ok())
      return true
    }

    case 'GET_ACCOUNTS': {
      await ensureSetupStateMatchesAccounts()
      let repairedCount = 0
      try {
        const { repairDisplacedPasskeySmartAccountAddresses } =
          await import('../api/repairPasskeyAddress')
        const repaired = await repairDisplacedPasskeySmartAccountAddresses()
        repairedCount = repaired.repairedCount
        if (repairedCount > 0) {
          const { clearSmartAccountBalancesMemoryCache } = await import('../smartAccountBalances')
          clearSmartAccountBalancesMemoryCache()
        }
      } catch {
        // best-effort repair only
      }
      const data = await getAccounts()
      let activeAccountHasMnemonicVault: boolean | undefined
      let activeAccountMnemonicSignerLoaded: boolean | undefined
      if (data.activeAccountId) {
        const active = data.accounts.find((a) => a.id === data.activeAccountId)
        if (active?.mode === 'mnemonic') {
          const rec = await loadMnemonicVaultRecord(active.id)
          activeAccountHasMnemonicVault = Boolean(rec)
          activeAccountMnemonicSignerLoaded = Boolean(getMnemonicKeypair(active.id))
        }
      }
      const payload: GetAccountsResponse = {
        ...data,
        activeAccountHasMnemonicVault,
        activeAccountMnemonicSignerLoaded,
      }
      sendResponse(ok(payload))
      return true
    }

    case 'SET_ACTIVE_ACCOUNT': {
      const req = message.payload as SetActiveAccountRequest
      await setActiveAccount(req.accountId)
      // storage.onChanged also broadcasts; await here so dApps update before UI continues
      await broadcastActiveAccountChanged()
      sendResponse(ok())
      return true
    }

    case 'CREATE_OR_CONNECT_PASSKEY': {
      const req = message.payload as CreateOrConnectPasskeyRequest
      const before = await getAccounts()
      const existing = before.accounts.find(
        (a) =>
          a.mode === 'passkey' &&
          ((req.credentialId && a.passkeyCredentialId === req.credentialId) ||
            (req.smartAccountAddress && a.smartAccountAddress === req.smartAccountAddress))
      )
      const data = await createOrConnectPasskey({
        keyDataHex: req.keyDataHex,
        credentialId: req.credentialId,
      })
      const existingAddr = existing?.smartAccountAddress?.trim()
      const hinted = req.smartAccountAddress?.trim()
      const apiAddr = data.smartAccountAddress?.trim() ?? ''
      const keepAddr = existingAddr || hinted
      if (keepAddr && apiAddr && keepAddr !== apiAddr) {
        const { recordPasskeyAddressDisplacement } = await import('../api/repairPasskeyAddress')
        await recordPasskeyAddressDisplacement({
          credentialId: req.credentialId,
          previousAddress: keepAddr,
          factoryAddress: apiAddr,
        })
      }
      // Never persist a different factory prediction over the funded local C-address.
      const smartAccountAddress = keepAddr || apiAddr
      const { account } = await createAccount({
        mode: 'passkey',
        smartAccountAddress,
        passkeyCredentialId: req.credentialId,
        passkeyKeyDataHex: req.keyDataHex,
      })
      sendResponse(
        ok({
          ...data,
          smartAccountAddress,
          alreadyDeployed: data.alreadyDeployed || Boolean(keepAddr && keepAddr === apiAddr),
          account,
        })
      )
      return true
    }

    case 'PASSKEY_REG_BEGIN': {
      const req = (message.payload as { displayName?: string } | undefined) ?? undefined
      const data = await passkeyRegistrationBegin(req)
      sendResponse(ok(data))
      return true
    }

    case 'PASSKEY_REG_FINISH': {
      const req = message.payload as BackendWebauthnRegistrationFinishRequest
      const data = await passkeyRegistrationFinish(req)
      let keyDataHex = typeof data.keyDataHex === 'string' ? data.keyDataHex.trim() : ''
      let credentialId = data.credentialId
      // Backend should return keyDataHex; fall back to client extraction so send/sign can proceed.
      if (!keyDataHex && req.response) {
        try {
          const { extractRegistrationKeyData } = await import('../../ui/webauthn/passkey')
          const extracted = extractRegistrationKeyData(req.response)
          keyDataHex = extracted.keyDataHex
          if (!credentialId) credentialId = extracted.credentialId
        } catch {
          // keep empty; createAccount will surface missing data on send/setup
        }
      }
      const { account } = await createAccount({
        mode: 'passkey',
        smartAccountAddress: data.smartAccountAddress,
        passkeyCredentialId: credentialId,
        passkeyKeyDataHex: keyDataHex || undefined,
      })
      sendResponse(ok({ ...data, credentialId, keyDataHex, account }))
      return true
    }

    case 'GET_BACKEND_ACCOUNTS': {
      const data = await getBackendAccounts()
      sendResponse(ok(data))
      return true
    }

    case 'PASSKEY_AUTH_BEGIN': {
      const data = await passkeyAuthenticationBegin()
      sendResponse(ok(data))
      return true
    }

    case 'PASSKEY_AUTH_FINISH': {
      const req = message.payload as BackendWebauthnAuthenticationFinishRequest
      const data = await passkeyAuthenticationFinish(req)

      const activeCredentialId = data.activeCredentialId ?? data.accounts?.[0]?.credentialId
      if (!activeCredentialId) {
        throw new BackendError('Passkey login did not return a credential id.', {
          code: 'invalid_response',
        })
      }

      // Only the credential that just completed the ceremony is persisted.
      // `data.accounts` is every smart account on the API session user, which
      // can include wallets from other passkeys that this login did not prove.
      const { account, activeAccountId } = await createAccount({
        mode: 'passkey',
        smartAccountAddress: data.smartAccountAddress,
        passkeyCredentialId: activeCredentialId,
        passkeyKeyDataHex: data.keyDataHex,
      })

      await removeRemovedAccountAddress(data.smartAccountAddress)

      const accRes = await getAccounts()
      sendResponse(ok({ ...data, account, accounts: accRes.accounts, activeAccountId }))
      return true
    }

    case 'RENAME_ACCOUNT': {
      const req = message.payload as { accountId: string; label?: string }
      await renameAccount(req)
      sendResponse(ok())
      return true
    }

    case 'DELETE_ACCOUNT': {
      const req = message.payload as DeleteAccountRequest
      const result = await deleteAccount(req.accountId)
      clearMnemonicSessionKeyForAccount(req.accountId)
      if (result.removedLastAccount) {
        // Nothing left to prove who this user is; drop the API session too so a
        // later hydrate cannot re-import the old session user's wallets.
        await clearLatchApiSession()
      }
      await ensureSetupStateMatchesAccounts()
      await broadcastActiveAccountChanged()
      const payload: DeleteAccountResponse = result
      sendResponse(ok(payload))
      return true
    }

    case 'IMPORT_MNEMONIC_ACCOUNT': {
      const req = message.payload as ImportMnemonicAccountRequest
      if (req.remember && (!req.encryptionPassword || req.encryptionPassword.length < 8)) {
        throw new BackendError(
          'Choose an encryption password of at least 8 characters to remember your seed.',
          {
            code: 'invalid_input',
          }
        )
      }
      const { keypair, gAddress } = deriveStellarKeypairFromMnemonic(
        req.mnemonic,
        req.bip39Passphrase
      )
      const data = await ensureFreighterSmartAccountDeployed(gAddress)
      const { account } = await createAccount({
        mode: 'mnemonic',
        smartAccountAddress: data.smartAccountAddress,
        gAddress,
      })
      registerMnemonicKeypair(account.id, keypair)
      if (req.remember && req.encryptionPassword) {
        const record = await encryptMnemonicForVault({
          accountId: account.id,
          mnemonic: req.mnemonic,
          bip39Passphrase: req.bip39Passphrase ?? '',
          encryptionPassword: req.encryptionPassword,
        })
        await saveMnemonicVaultRecord(record)
      }
      sendResponse(
        ok({
          gAddress,
          smartAccountAddress: data.smartAccountAddress,
          alreadyDeployed: data.alreadyDeployed,
          account,
        })
      )
      return true
    }

    case 'UNLOCK_MNEMONIC_VAULT': {
      const req = message.payload as UnlockMnemonicVaultRequest
      const record = await loadMnemonicVaultRecord(req.accountId)
      if (!record) {
        throw new BackendError('No encrypted seed is stored for this account.', {
          code: 'no_vault',
        })
      }
      const { mnemonic, bip39Passphrase } = await decryptMnemonicFromVault(
        record,
        req.encryptionPassword
      )
      const { keypair, gAddress } = deriveStellarKeypairFromMnemonic(
        mnemonic,
        bip39Passphrase ? bip39Passphrase : undefined
      )
      const { accounts } = await getAccounts()
      const acc = accounts.find((a) => a.id === req.accountId)
      if (!acc || acc.mode !== 'mnemonic' || acc.gAddress !== gAddress) {
        throw new BackendError('Account does not match saved seed.', { code: 'account_mismatch' })
      }
      registerMnemonicKeypair(acc.id, keypair)
      sendResponse(ok())
      return true
    }

    default:
      return false
  }
}
