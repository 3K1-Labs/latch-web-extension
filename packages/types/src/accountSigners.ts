/**
 * Backup passkey signers for solo smart accounts.
 *
 * A second WebAuthn credential can be authorized on an existing account's
 * Default context rule, so either passkey can sign alone (1-of-N) and a fresh
 * device that restores *either* credential lands on the same `C…` address.
 *
 * The API is two-phase on purpose: the build routes never touch the recovery
 * index, and a separate `/confirm` re-fetches the settled transaction and
 * decodes it before recording `signer_id` / writing `passkey_credentials`.
 * See `LATCH_BACKEND_SOLO_BACKUP_SIGNERS.md`.
 */

import type { BuildSendTxResponse, Network } from './index'

/**
 * `POST /api/accounts/{smartAccountAddress}/signers/passkey/register`
 *
 * Same body as webauthn registration finish, but the handler deliberately does
 * not deploy: the credential is attached to an existing account instead of
 * deriving a new factory address.
 */
export interface AttachPasskeySignerRequest {
  response: unknown
  /** Passkey label, also used as the `account_signers` row label. */
  displayName?: string
  seq?: number
  network?: Network
}

export interface AttachPasskeySignerResponse {
  credentialId: string
  /** Uncompressed P-256 pubkey (65 bytes) || credentialIdBytes, for the new signer. */
  keyDataHex: string
  smartAccountAddress: string
  attached?: boolean
  /** Always false: attaching never deploys a wallet. */
  deployed?: boolean
  /** Always false: the signer is not authorized until `add_signer` lands on-chain. */
  signerOnChain?: boolean
  determinismCheck?: { keyDataHash?: string }
}

/** `POST /api/smart-account/add-signer` */
export interface AddAccountSignerRequest {
  smartAccountAddress: string
  /** The *backup* credential's key data, from the attach response. */
  keyDataHex: string
  credentialId?: string
  network?: Network
}

/**
 * Same `BuildAuthTransactionResult` field names `setup-swap-rules` returns, so
 * the existing passkey signer can submit it unchanged.
 */
export interface AddAccountSignerResponse extends BuildSendTxResponse {
  /** True when this key data already signs for the account; nothing to submit. */
  alreadyConfigured?: boolean
  message?: string
  signerCredentialId?: string
}

/** `POST /api/smart-account/add-signer/confirm` */
export interface ConfirmAddAccountSignerRequest {
  smartAccountAddress: string
  contextRuleId: number
  keyDataHex: string
  credentialId: string
  /** Persisted as the `passkey_credentials` label so restore shows the name. */
  label?: string
  seq?: number
  txHash: string
  network?: Network
}

export interface ConfirmAddAccountSignerResponse {
  confirmed?: boolean
  /** The `u32` the contract's `add_signer` returned; required later to remove. */
  signerId?: number
  smartAccountAddress?: string
  credentialId?: string
}

/** `POST /api/smart-account/remove-signer` */
export interface RemoveAccountSignerRequest {
  smartAccountAddress: string
  credentialId: string
  network?: Network
}

export interface RemoveAccountSignerResponse extends BuildSendTxResponse {
  signerId?: number
}

/** `POST /api/smart-account/remove-signer/confirm` */
export interface ConfirmRemoveAccountSignerRequest {
  smartAccountAddress: string
  credentialId: string
  contextRuleId: number
  txHash: string
  network?: Network
}

export interface ConfirmRemoveAccountSignerResponse {
  confirmed?: boolean
  signerId?: number
  /** The signer was already gone — an idempotent retry, not a failure. */
  alreadyRemoved?: boolean
}

/**
 * One signer as this install knows it.
 *
 * The API has no per-account signer list (`GET /api/accounts` deliberately
 * excludes signers, and the cookie-scoped credential list is not ownership
 * proof), so the Signers screen is built from records written here plus the
 * active account's own credential.
 */
export interface AccountSignerRecord {
  credentialId: string
  keyDataHex?: string
  label?: string
  seq?: number
  /** `primary` is the credential this install signs with. */
  role: 'primary' | 'backup'
  /** `onchain` once add-signer/confirm returned a signerId. */
  status: 'pending' | 'onchain'
  signerId?: number
  addedAt: number
  /**
   * Kept only while `status === 'pending'`: a signer can be authorized
   * on-chain while the index write failed, and that is only recoverable by
   * retrying confirm with the original hash.
   */
  pendingConfirm?: { txHash: string; contextRuleId: number }
}

export interface ListAccountSignersRequest {
  smartAccountAddress?: string
}

export interface ListAccountSignersResponse {
  smartAccountAddress: string
  signers: AccountSignerRecord[]
}

export interface AttachBackupPasskeyRequest {
  smartAccountAddress?: string
  response: unknown
  displayName?: string
  seq?: number
}

export interface AttachBackupPasskeyResponse {
  smartAccountAddress: string
  signer: AccountSignerRecord
}

export interface ExecuteAddBackupSignerRequest {
  smartAccountAddress?: string
  credentialId: string
  keyDataHex?: string
  label?: string
  seq?: number
  surface?: 'popup' | 'sidepanel'
  /** Skip the build/sign steps and retry confirm from the stored pendingConfirm. */
  resumeConfirmOnly?: boolean
}

export interface ExecuteAddBackupSignerResponse {
  smartAccountAddress: string
  signer: AccountSignerRecord
  alreadyConfigured?: boolean
  txHash?: string
}

export interface ExecuteRemoveAccountSignerRequest {
  smartAccountAddress?: string
  credentialId: string
  surface?: 'popup' | 'sidepanel'
}

export interface ExecuteRemoveAccountSignerResponse {
  smartAccountAddress: string
  credentialId: string
  txHash?: string
  alreadyRemoved?: boolean
}
