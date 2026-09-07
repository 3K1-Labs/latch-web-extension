/**
 * @latch/types
 * Shared TypeScript types across all packages and apps.
 * No runtime code — types only.
 */

// ---------------------------------------------------------------------------
// SEP-0043 types
// https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
// ---------------------------------------------------------------------------

/** Options accepted by the SEP-0043 `signTransaction(xdr, opts?)` method. */
export interface Sep0043SignTransactionOptions {
  /** Stellar network passphrase — mapped to Latch `network` (testnet | mainnet). */
  networkPassphrase?: string
  /**
   * Hint to the wallet: which account should sign.
   * Mapped onto `accountToSign`; should be the active smart-account C… address.
   */
  address?: string
  /** When true the wallet broadcasts the signed tx itself; Latch v1 adapter rejects this. */
  submit?: boolean
  /** Custom submit URL (SEP-0043 extension). Not supported in Latch v1. */
  submitUrl?: string
}

/** Return value of SEP-0043 `getAddress()`. */
export interface Sep0043GetAddressResponse {
  /** The active smart-account address — a Soroban contract address (C…). */
  address: string
}

/** Return value of SEP-0043 `signTransaction(xdr, opts?)`. */
export interface Sep0043SignTransactionResponse {
  /** Base64-encoded signed transaction XDR. */
  signedTxXdr: string
  /** The address that signed the transaction (smart-account C… address). */
  signerAddress: string
}

/**
 * Return value of SEP-0043 `getNetwork()` object shape.
 * Exposed on `window.latch.getNetworkDetails()` — Latch-native `getNetwork()`
 * still returns `'testnet' | 'mainnet'`.
 */
export interface Sep0043GetNetworkResponse {
  /** Freighter-compatible network name (e.g. `'TESTNET'` | `'PUBLIC'`). */
  network: 'TESTNET' | 'PUBLIC'
  /** Stellar network passphrase. */
  networkPassphrase: string
}

/** SEP-0043 error codes per the spec. */
export type Sep0043ErrorCode = -1 | -2 | -3 | -4

/** Error shape thrown by SEP-0043 adapter methods on `window.latch`. */
export interface Sep0043Error {
  message: string
  code: Sep0043ErrorCode
  /** Optional extensions (reserved for future use). */
  ext?: string[]
}

export type Network = 'testnet' | 'mainnet'

export interface SignTransactionRequest {
  xdr: string
  network: Network
  accountToSign: string
  /**
   * When false, the wallet signs but does not broadcast. The response returns
   * `signedTxXdr` (and `signedAuthEntry`) so the dApp can submit itself.
   * Defaults to true (wallet signs and submits, returning `txHash`).
   */
  submit?: boolean
}

export interface SignTransactionResponse {
  txHash?: string
  signedAuthEntry?: string
  signedTxXdr?: string
  /** @deprecated Prefer txHash when wallet submits on behalf of dapp */
  signedXdr?: string
}

export type AccountMode = 'passkey' | 'mnemonic' | 'multisig'

export interface StoredAccount {
  id: string
  mode: AccountMode

  /** Local-only user label (stored in chrome.storage.local). */
  label?: string

  /** Soroban smart account address */
  smartAccountAddress: string

  /** Stellar G-address; required for mnemonic delegated signing. */
  gAddress?: string

  /** Base64url credential ID, for Passkey/WebAuthn */
  passkeyCredentialId?: string

  /**
   * Passkey keyDataHex as required by backend:
   * uncompressed P-256 pubkey (65 bytes) || credentialIdBytes
   */
  passkeyKeyDataHex?: string

  /** Present when `mode === 'multisig'`. */
  multisigThreshold?: number
  /**
   * Backend `multisig_members.id` for this session user on this wallet.
   * Required for `/api/multisig` proposal approve/execute.
   */
  multisigMemberId?: string
  /** Backend `multisig_accounts.id` for this wallet. */
  multisigBackendAccountId?: string
  /** Cosign (unwired / not shipped): background WCK record id (IndexedDB). */
  cosignWckRefId?: string
  /** Cosign (unwired / not shipped): cached HMAC blind signer id for this member. */
  cosignBlindSignerId?: string
  /** Cosign (unwired / not shipped): local passkey/mnemonic account id used to sign. */
  cosignLinkedAccountId?: string
  /** Factory deploy salt for this multisig wallet. */
  multisigAccountSaltHex?: string
  /**
   * Cached draft/account members for register+sync after deploy.
   * Prefer MultisigDraftMember shape from `/api/multisig`; CosignMemberInit
   * may appear on unwired cosign paths.
   */
  multisigMembersSnapshot?:
    | import('./multisig').MultisigDraftMember[]
    | import('./cosign').CosignMemberInit[]

  createdAt: number
}

export interface GetAccountsResponse {
  accounts: StoredAccount[]
  activeAccountId?: string
  /** Present when the active account is `mnemonic` and an encrypted seed exists (`remember`). */
  activeAccountHasMnemonicVault?: boolean
  /**
   * When active account is `mnemonic`, true if the seed signer is loaded in the service worker session
   * (unlocked or just imported). False when a vault exists but the SW was restarted and the user must unlock.
   */
  activeAccountMnemonicSignerLoaded?: boolean
}

/** One row for smart-account (C) Soroban SAC balances shown on Home. */
export interface SmartAccountBalanceRow {
  code: string
  issuer?: string
  sacContractId: string
  /** Catalog id from Latch API (e.g. `native`, `USDC`) for build-send. */
  assetId?: string
  /** SAC display decimals from API catalog. */
  decimals?: number
  /** Human-readable amount (trimmed), Soroban SAC 7 decimals for display. */
  amount: string
  /** data: URL resolved in background (CSP-safe for extension UI). */
  iconUrl?: string | null
  /** USD value from interim hardcoded prices (display string, 2 dp). */
  balanceUsd?: string
}

/** Balance entry from `GET /api/smart-account/balances`. */
export interface ApiSmartAccountBalance {
  assetId: string
  symbol: string
  name?: string
  contractId: string
  decimals: number
  balance: string
  balanceRaw?: string
}

export interface GetSmartAccountBalancesApiResponse {
  smartAccountAddress: string
  balances: ApiSmartAccountBalance[]
}

/**
 * Backend build/setup contract (`BuildSendTxRequest.signerType`, etc.).
 * `'freighter'` is the wire value for delegated G-signer builds and is what
 * mnemonic accounts send; do not rename without a coordinated backend change.
 */
export type SendSignerType = 'passkey' | 'freighter'

export interface BuildSendTxRequest {
  smartAccountAddress: string
  signerType: SendSignerType
  recipient: string
  amount: string
  assetId?: string
  contractId?: string
  signerG?: string
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface BuildSendAssetInfo {
  assetId: string
  symbol: string
  contractId: string
  decimals: number
}

export interface BuildSendTxResponse {
  txXdr: string
  authEntryXdr: string
  authEntriesXdr?: string[]
  smartAccountAuthEntryIndex?: number
  contextRuleId: number | string
  contextRuleIds?: number[]
  authDigestHex: string
  signaturePayloadHex?: string
  validUntilLedger: number
  simulationResultXdr?: string
  asset?: BuildSendAssetInfo
  recipient?: string
  amount?: string
  amountRaw?: string
  /** Freighter / delegated path */
  smartAccountAuthEntryXdr?: string
  gAddressPreimageXdr?: string
  gAddressEntryTemplateXdr?: string
  estimatedFeeXlm?: string
  estimatedFeeUsd?: string
  feeLabel?: string
  delegatedGAuthEntrySynthesized?: boolean
  delegatedNativeAuthEntryIndices?: number[]
  delegatedNativeSignBlobPayloadsBase64?: string[]
  submitMethod?: 'webauthn' | 'delegated' | 'bundler-delegated'
  [k: string]: unknown
}

export interface SetupSendRulesRequest {
  smartAccountAddress: string
  signerType: SendSignerType
  assetId?: string
  assetIds?: string[]
  publicKeyHex?: string
  /** WebAuthn verifier C-address (must match Latch API `NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS`). */
  verifierAddress?: string
  keyDataHex?: string
  /** Optional WebAuthn credential id (base64url). */
  credentialId?: string
  gAddress?: string
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface SetupSendRulesResponse extends BuildSendTxResponse {
  alreadyConfigured?: boolean
  message?: string
  configuredAsset?: BuildSendAssetInfo
  remainingSetupCount?: number
  instructions?: string
}

export interface GetSmartAccountBalancesRequest {
  accountId: string
  /** Optional per-view id; UI sends CANCEL_REQUEST with the same id to detach the waiter. */
  requestId?: string
}

export interface GetSmartAccountBalancesResponse {
  rows: SmartAccountBalanceRow[]
  totalBalanceUsd?: string
}

export interface RecordKnownSacProbeRequest {
  accountId: string
  probe: {
    code: string
    issuer?: string
    sacContractId: string
  }
}

export type SmartAccountTransactionKind = 'sent' | 'received' | 'deposit' | 'swap'
export type SmartAccountTransactionStatus = 'completed' | 'pending'

export interface SmartAccountTransactionRow {
  id: string
  transactionHash: string
  createdAt: string
  direction: 'sent' | 'received'
  assetCode: string
  amount: string
  amountLabel: string
  amountUsd: string | null
  status: SmartAccountTransactionStatus
  kind: SmartAccountTransactionKind
  from: string
  to: string
}

export interface GetSmartAccountTransactionsRequest {
  accountId: string
  /** Bypass fresh TTL and recompute (History pull-to-refresh). */
  force?: boolean
  /** Optional per-view id; UI sends CANCEL_REQUEST with the same id to detach the waiter. */
  requestId?: string
}

export interface GetSmartAccountTransactionsResponse {
  items: SmartAccountTransactionRow[]
}

export interface GetAssetIconDataUrlsRequest {
  assets: { code: string; issuer?: string; sacContractId?: string }[]
}

export interface GetAssetIconDataUrlsResponse {
  /** Parallel to `assets`; null when unknown or failed. */
  icons: (string | null)[]
}

export interface SetActiveAccountRequest {
  accountId: string
}

export interface CreateOrConnectFreighterRequest {
  gAddress: string
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface CreateOrConnectFreighterResponse {
  smartAccountAddress: string
  alreadyDeployed: boolean
}

/** GET /api/smart-account/freighter?gAddress=… — shape may include backend aliases */
export interface FreighterSmartAccountStatusResponse {
  deployed: boolean
  smartAccountAddress: string
}

export interface ImportMnemonicAccountRequest {
  mnemonic: string
  bip39Passphrase?: string
  remember?: boolean
  encryptionPassword?: string
}

export interface ImportMnemonicAccountResponse {
  gAddress: string
  smartAccountAddress: string
  alreadyDeployed: boolean
  account: StoredAccount
}

export interface UnlockMnemonicVaultRequest {
  accountId: string
  encryptionPassword: string
}

export interface SignDelegatedGAuthEntryRequest {
  accountId: string
  /** Unsigned Soroban authorization entry XDR (base64); used with stellar-base `authorizeEntry`. */
  gAddressEntryTemplateXdr: string
  /** Stellar network passphrase (e.g. `Networks.TESTNET`); must match the delegated build. */
  networkPassphrase: string
}

export interface SignDelegatedGAuthEntryResponse {
  signedAuthEntryBase64: string
  signerAddress: string
}

export interface CreateOrConnectPasskeyRequest {
  keyDataHex: string
  credentialId: string
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
  /**
   * Extension-only hint: when set, skip deploy POST if this C-address already has a
   * contract instance on the active network. Never forwarded to the Latch API body.
   */
  smartAccountAddress?: string
}

export interface CreateOrConnectPasskeyResponse {
  smartAccountAddress: string
  alreadyDeployed: boolean
}

/** SAC transfer intent for smart-account outbound send. */
export interface BuildTransferIntent {
  sacContractId: string
  assetCode: string
  assetIssuer?: string
  destination: string
  /** Human-readable amount (typically 7 dp for SAC). */
  amount: string
  memo?: string
}

export interface BuildTxRequest {
  smartAccountAddress: string
  signerG?: string
  transfer?: BuildTransferIntent
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface BuildTxResponse {
  txXdr: string
  authEntryXdr: string
  authDigestHex: string
  contextRuleId: string
  validUntilLedger: number
  estimatedFeeXlm?: string
  estimatedFeeUsd?: string
  feeLabel?: string
  // allow backend to add more fields without breaking
  [k: string]: unknown
}

export interface BuildDelegatedTxRequest {
  smartAccountAddress: string
  gAddress: string
  transfer?: BuildTransferIntent
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface BuildDelegatedTxResponse {
  txXdr: string
  smartAccountAuthEntryXdr: string
  gAddressPreimageXdr: string
  gAddressEntryTemplateXdr: string
  authDigestHex: string
  estimatedFeeXlm?: string
  estimatedFeeUsd?: string
  feeLabel?: string
}

export interface SubmitDelegatedTxRequest {
  txXdr: string
  smartAccountAuthEntryXdr: string
  gAddressEntryTemplateXdr: string
  /** Base64 of raw 64-byte Ed25519 signature (not full signed auth entry XDR). */
  signedAuthEntryBase64: string
  signerAddress: string
  contextRuleId?: number
  delegatedNativeAuthEntryIndex?: number
  delegatedNativeAuthEntryIndices?: number[]
  authEntriesXdr?: string[]
  smartAccountAuthEntryIndex?: number
  delegatedGAuthEntrySynthesized?: boolean
  /** When false, backend signs + assembles but returns `signedTxXdr` without broadcasting. */
  submit?: boolean
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface SubmitWebauthnTxRequest {
  txXdr: string
  authEntryXdr: string
  sigDataXdr: string
  keyDataHex: string
  contextRuleId?: number
  authEntriesXdr?: string[]
  smartAccountAuthEntryIndex?: number
  delegatedGAuthEntrySynthesized?: boolean
  /** When false, backend signs + assembles but returns `signedTxXdr` without broadcasting. */
  submit?: boolean
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface SubmitTxResponse {
  transactionHash?: string
  hash?: string
  status?: string
  /** Present when the request used `submit: false`; a submit-ready signed tx envelope. */
  signedTxXdr?: string
  /** False when the backend signed but did not broadcast. */
  submitted?: boolean
  // backend response is not specified; accept opaque
  [k: string]: unknown
}

export interface BackendWebauthnBeginResponse {
  options: unknown
}

export interface BackendWebauthnRegistrationFinishRequest {
  response: unknown
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface BackendWebauthnRegistrationFinishResponse {
  credentialId: string
  keyDataHex: string
  smartAccountAddress: string
  deployed: boolean
  alreadyDeployed: boolean
  [k: string]: unknown
}

export interface BackendWebauthnAuthenticationFinishRequest {
  response: unknown
  /** Stellar network; omit → API defaults to testnet. */
  network?: Network
}

export interface BackendSessionAccount {
  smartAccountAddress: string
  credentialId?: string
  deployed?: boolean
  createdAt?: number
  [k: string]: unknown
}

export interface BackendAccountsResponse {
  accounts: BackendSessionAccount[]
}

export interface BackendWebauthnAuthenticationFinishResponse {
  smartAccountAddress: string
  keyDataHex: string
  deployed: boolean
  activeCredentialId?: string
  accounts: BackendSessionAccount[]
  [k: string]: unknown
}

export type DappPermission = 'getPublicKey' | 'signTransaction'

export type PendingDappRequestKind = DappPermission | 'externalSignReview'

export interface PendingDappRequest {
  id: string
  origin: string
  kind: PendingDappRequestKind
  createdAt: number
  signRequest?: import('./externalSign').ExternalSignRequest
  prepared?: import('./externalSign').PrepareSignResponse
  localReview?: import('./externalSign').ExternalSignLocalReview
  source?: import('./externalSign').ExternalSignSource
}

export type ListPendingDappRequestsRequest = Record<string, never>

export interface ListPendingDappRequestsResponse {
  requests: PendingDappRequest[]
}

export interface ResolvePendingDappRequest {
  requestId: string
  approved: boolean
  /** When approved is false and set, dapp receives status "error" instead of "rejected". */
  errorMessage?: string
  errorCode?: string
  signedXdr?: string
  txHash?: string
  signedAuthEntry?: string
  signedTxXdr?: string
}

export interface GetDappPermissionsRequest {
  origin: string
}

export interface GetDappPermissionsResponse {
  origin: string
  allowed: DappPermission[]
}

export interface SetDappPermissionsRequest {
  origin: string
  allowed: DappPermission[]
}

export interface DappGetPublicKeyResponse {
  publicKey: string
}

export interface DappSignTransactionRequest {
  origin?: string
  request: SignTransactionRequest
}

export interface DappSignTransactionResponse {
  response: SignTransactionResponse
}

export interface SerializableError {
  message: string
  code?: string
  status?: number
}

/** G → smart account (C) asset migration — discovery only; sweep uses separate messages. */
export type MigrationDiscoveryState = 'not_needed' | 'not_started' | 'complete' | 'unsupported'

export type MigrableAssetKind = 'native' | 'token'

export interface MigrableAsset {
  kind: MigrableAssetKind
  code: string
  issuer?: string
  /** Human-readable amount for display / sweep input */
  amount: string
  /** Stellar Asset Contract contract id for this asset */
  sacContractId: string
}

export interface MigrationDiscovery {
  state: MigrationDiscoveryState
  gAddress: string
  cAddress: string
  assets: MigrableAsset[]
  /** When state is `unsupported` */
  unsupportedReason?: 'not_mnemonic' | 'missing_addresses'
}

export interface MigrationDiscoverRequest {
  accountId: string
}

export interface MigrationSweepResult {
  success: boolean
  txHash?: string
  ledger?: number
  error?: SerializableError
}

export interface MigrationSweepXlmRequest {
  accountId: string
  /**
   * How many SAC token sweeps will run after this XLM sweep (migration UI passes this).
   * Used to reserve XLM on G for their Soroban fees plus a minimum linger balance.
   */
  pendingTokenSweepCount?: number
}

export interface MigrationSweepTokenRequest {
  accountId: string
  sacContractId: string
}

export interface GetMarketPricesRequest {
  tokens: string[]
}

export type MarketTokenPrice = {
  priceUsd: number
  change24h: number
}

export interface GetMarketPricesResponse {
  updatedAtMs: number | null
  pricesByCodeUpper: Record<string, MarketTokenPrice>
}

/** On-ramp crypto locked into a Transak / deposit-intent session. */
export type DepositOnRampCrypto = 'XLM' | 'USDC'

/** Per-funding-session latch-relayer deposit intent (`POST /v1/accounts/deposit-intent`). */
export interface DepositIntent {
  intent_id: string
  memo_id: string
  pool_address: string
  expires_at: string
  /**
   * Server-built on-ramp widget URL (snake_case from Latch API).
   * MoonPay: HMAC-signed buy URL. Transak: Create Widget URL session (`widgetUrl`).
   */
  widget_url?: string
  /** Server-built on-ramp widget URL (camelCase alias). */
  widgetUrl?: string
}

export interface DepositForward {
  tx_hash: string
  amount: string
  asset: string
  status: string
  forward_tx?: string
  created_at: string
}

export interface DepositStatus {
  intent_id: string
  memo_id: string
  c_address: string
  pool_address: string
  status: 'pending' | 'completed' | 'expired' | 'failed' | string
  expires_at: string
  forwards: DepositForward[]
}

export interface CreateDepositIntentRequest {
  accountId: string
  /** When true, background opens the MoonPay buy tab after minting the intent. */
  openMoonPay?: boolean
  /** When true, background opens the Transak widget tab after minting the intent. */
  openTransak?: boolean
  /** Required when `openTransak` is true — locked into the Transak session. */
  cryptoCurrency?: DepositOnRampCrypto
}

export interface GetDepositIntentStatusRequest {
  accountId: string
  memoId: string
}

// Message types for popup/content ↔ background communication
export type MessageType =
  | 'SIGN_TRANSACTION'
  | 'GET_PUBLIC_KEY'
  | 'UNLOCK_VAULT'
  | 'LOCK_VAULT'
  | 'LOGOUT'
  | 'GET_SETUP_STATE'
  | 'SET_SETUP_STATE'
  | 'GET_ACCOUNTS'
  | 'SET_ACTIVE_ACCOUNT'
  | 'CREATE_OR_CONNECT_PASSKEY'
  | 'IMPORT_MNEMONIC_ACCOUNT'
  | 'UNLOCK_MNEMONIC_VAULT'
  | 'SIGN_DELEGATED_G_AUTH_ENTRY'
  | 'BUILD_TX'
  | 'BUILD_DELEGATED_TX'
  | 'SUBMIT_TX_DELEGATED'
  | 'SUBMIT_TX_WEBAUTHN'
  | 'PASSKEY_REG_BEGIN'
  | 'PASSKEY_REG_FINISH'
  | 'PASSKEY_AUTH_BEGIN'
  | 'PASSKEY_AUTH_FINISH'
  | 'GET_BACKEND_ACCOUNTS'
  | 'RENAME_ACCOUNT'
  | 'GET_DAPP_PERMISSIONS'
  | 'SET_DAPP_PERMISSIONS'
  | 'LIST_PENDING_DAPP_REQUESTS'
  | 'RESOLVE_PENDING_DAPP_REQUEST'
  | 'DAPP_GET_PUBLIC_KEY'
  | 'DAPP_SIGN_TRANSACTION'
  | 'DAPP_OPEN_SIGN_REQUEST'
  | 'MIGRATION_DISCOVER'
  | 'MIGRATION_SWEEP_XLM'
  | 'MIGRATION_SWEEP_TOKEN'
  | 'GET_SMART_ACCOUNT_BALANCES'
  | 'GET_SMART_ACCOUNT_TRANSACTIONS'
  | 'GET_MARKET_PRICES'
  | 'CREATE_DEPOSIT_INTENT'
  | 'GET_DEPOSIT_INTENT_STATUS'
  | 'GET_ASSET_ICON_DATA_URLS'
  | 'BUILD_SEND_TX'
  | 'SETUP_SEND_RULES'
  | 'OPEN_WALLET_AFTER_ONBOARDING'
  | 'OPEN_ONBOARDING_TAB'
  | 'PREPARE_EXTERNAL_SIGN'
  | 'RUN_EXTERNAL_SIGN_FLOW'
  | 'GET_ACTIVE_NETWORK'
  | 'SET_ACTIVE_NETWORK'
  | 'PING_EXTENSION'
  | 'CANCEL_REQUEST'
  | 'GET_SWAP_TOKEN_CATALOG'
  | 'GET_SWAP_QUOTE'
  | 'PREPARE_SWAP_TX'
  | 'SETUP_SWAP_RULES'
  | 'RECORD_KNOWN_SAC_PROBE'
  | 'MULTISIG_CREATE_DRAFT'
  | 'MULTISIG_GET_ACTIVE_DRAFT'
  | 'MULTISIG_ADD_DRAFT_MEMBER'
  | 'MULTISIG_REMOVE_DRAFT_MEMBER'
  | 'MULTISIG_UPDATE_DRAFT_THRESHOLD'
  | 'MULTISIG_PREDICT_DRAFT'
  | 'MULTISIG_DEPLOY_DRAFT'
  | 'MULTISIG_DRAFT_PASSKEY_REG_BEGIN'
  | 'MULTISIG_DRAFT_PASSKEY_REG_FINISH'
  | 'MULTISIG_DRAFT_PASSKEY_AUTH_BEGIN'
  | 'MULTISIG_DRAFT_PASSKEY_AUTH_FINISH'
  | 'MULTISIG_LIST_ACCOUNTS'
  | 'MULTISIG_REGISTER_ACCOUNT'
  | 'MULTISIG_JOIN_PREVIEW'
  | 'MULTISIG_JOIN_MEMBER'
  | 'MULTISIG_JOIN_PASSKEY_REG_BEGIN'
  | 'MULTISIG_JOIN_PASSKEY_REG_FINISH'
  | 'MULTISIG_JOIN_PASSKEY_AUTH_BEGIN'
  | 'MULTISIG_JOIN_PASSKEY_AUTH_FINISH'
  | 'MULTISIG_LIST_PROPOSALS'
  | 'MULTISIG_GET_PROPOSAL'
  | 'MULTISIG_CREATE_PROPOSAL'
  | 'MULTISIG_APPROVE_DELEGATED_BEGIN'
  | 'MULTISIG_APPROVE_DELEGATED_FINISH'
  | 'MULTISIG_APPROVE_WEBAUTHN'
  | 'MULTISIG_EXECUTE_PROPOSAL'
  | 'MULTISIG_REFRESH_PROPOSAL'
  | 'MULTISIG_CREATE_LOCAL_ACCOUNT'
  | 'MULTISIG_GET_PENDING_INVITES'
  | 'MULTISIG_ADD_PENDING_INVITE'
  | 'MULTISIG_REMOVE_PENDING_INVITE'
  | 'MULTISIG_GET_DRAFT_META'
  | 'MULTISIG_SET_DRAFT_META'
  | 'MULTISIG_CLEAR_DRAFT_META'
  | 'MULTISIG_SYNC_LOCAL_ACCOUNTS'
  | 'MULTISIG_GET_PROPOSALS_BANNER_DISMISSED'
  | 'MULTISIG_DISMISS_PROPOSALS_BANNER'
  | 'COSIGN_GET_TRANSPORT_PUBKEY'
  | 'COSIGN_DEPLOY_ACCOUNT'
  | 'COSIGN_POST_JOIN_RELAY'
  | 'COSIGN_POLL_JOIN_RELAY'
  | 'COSIGN_SEAL_MEMBER_WCK'
  | 'COSIGN_DISCOVER_MEMBERSHIPS'
  | 'COSIGN_LIST_PENDING'
  | 'COSIGN_GET_REQUEST'
  | 'COSIGN_PROPOSE'
  | 'COSIGN_SIGN_REQUEST'
  | 'COSIGN_EXECUTE_REQUEST'
  | 'COSIGN_CANCEL_REQUEST'
  | 'COSIGN_GET_WCK_RECORD'
  | 'COSIGN_ENSURE_V1_AUTH'
  | 'COSIGN_V1_AUTH_CHALLENGE'
  | 'COSIGN_V1_AUTH_SIGN_IN'
  | 'COSIGN_CREATE_LOCAL_ACCOUNT'
  | 'COSIGN_GET_PROPOSALS_BANNER_DISMISSED'
  | 'COSIGN_DISMISS_PROPOSALS_BANNER'
  | 'COSIGN_RUN_POLL'
  | 'COSIGN_PREDICT_ACCOUNT'
  | 'COSIGN_PREPARE_SIGN'
  | 'COSIGN_ATTACH_WEBAUTHN_AUTH'

export type SetupState = 'new' | 'onboarding_done' | 'has_account'

export interface BackgroundMessage<T = unknown> {
  type: MessageType
  payload: T
}

export interface BackgroundResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: SerializableError
}

export interface GetSetupStateResponse {
  setupState: SetupState
  accountPublicKey?: string
}

export interface SetSetupStateRequest {
  setupState: SetupState
  accountPublicKey?: string
}

export interface CancelRequest {
  requestId: string
}

export type BackgroundRequestPayloadByType = {
  LOGOUT: undefined
  GET_SETUP_STATE: undefined
  SET_SETUP_STATE: SetSetupStateRequest
  GET_ACCOUNTS: undefined
  SET_ACTIVE_ACCOUNT: SetActiveAccountRequest
  CREATE_OR_CONNECT_PASSKEY: CreateOrConnectPasskeyRequest
  IMPORT_MNEMONIC_ACCOUNT: ImportMnemonicAccountRequest
  UNLOCK_MNEMONIC_VAULT: UnlockMnemonicVaultRequest
  SIGN_DELEGATED_G_AUTH_ENTRY: SignDelegatedGAuthEntryRequest
  BUILD_TX: BuildTxRequest
  BUILD_DELEGATED_TX: BuildDelegatedTxRequest
  SUBMIT_TX_DELEGATED: SubmitDelegatedTxRequest
  SUBMIT_TX_WEBAUTHN: SubmitWebauthnTxRequest
  PASSKEY_REG_BEGIN: { displayName?: string } | undefined
  PASSKEY_REG_FINISH: BackendWebauthnRegistrationFinishRequest
  PASSKEY_AUTH_BEGIN: undefined
  PASSKEY_AUTH_FINISH: BackendWebauthnAuthenticationFinishRequest
  GET_BACKEND_ACCOUNTS: undefined
  RENAME_ACCOUNT: { accountId: string; label?: string }
  GET_DAPP_PERMISSIONS: GetDappPermissionsRequest
  SET_DAPP_PERMISSIONS: SetDappPermissionsRequest
  LIST_PENDING_DAPP_REQUESTS: ListPendingDappRequestsRequest
  RESOLVE_PENDING_DAPP_REQUEST: ResolvePendingDappRequest
  DAPP_GET_PUBLIC_KEY: GetDappPermissionsRequest
  DAPP_SIGN_TRANSACTION: DappSignTransactionRequest
  DAPP_OPEN_SIGN_REQUEST: import('./externalSign').DappOpenSignRequestPayload
  MIGRATION_DISCOVER: MigrationDiscoverRequest
  MIGRATION_SWEEP_XLM: MigrationSweepXlmRequest
  MIGRATION_SWEEP_TOKEN: MigrationSweepTokenRequest
  GET_SMART_ACCOUNT_BALANCES: GetSmartAccountBalancesRequest
  GET_SMART_ACCOUNT_TRANSACTIONS: GetSmartAccountTransactionsRequest
  GET_MARKET_PRICES: GetMarketPricesRequest
  CREATE_DEPOSIT_INTENT: CreateDepositIntentRequest
  GET_DEPOSIT_INTENT_STATUS: GetDepositIntentStatusRequest
  GET_ASSET_ICON_DATA_URLS: GetAssetIconDataUrlsRequest
  BUILD_SEND_TX: BuildSendTxRequest
  SETUP_SEND_RULES: SetupSendRulesRequest
  OPEN_WALLET_AFTER_ONBOARDING: undefined
  OPEN_ONBOARDING_TAB: undefined
  PREPARE_EXTERNAL_SIGN: import('./externalSign').RunExternalSignFlowRequest
  RUN_EXTERNAL_SIGN_FLOW: import('./externalSign').RunExternalSignFlowRequest
  GET_ACTIVE_NETWORK: undefined
  SET_ACTIVE_NETWORK: { network: Network }
  PING_EXTENSION: undefined
  CANCEL_REQUEST: CancelRequest
  GET_SWAP_TOKEN_CATALOG: import('./swap').GetSwapTokenCatalogRequest
  GET_SWAP_QUOTE: import('./swap').GetSwapQuoteRequest
  PREPARE_SWAP_TX: import('./swap').PrepareSwapTxRequest
  SETUP_SWAP_RULES: import('./swap').SetupSwapRulesRequest
  RECORD_KNOWN_SAC_PROBE: RecordKnownSacProbeRequest
  MULTISIG_CREATE_DRAFT: undefined
  MULTISIG_GET_ACTIVE_DRAFT: undefined
  MULTISIG_ADD_DRAFT_MEMBER: import('./multisig').MultisigDraftMemberActionRequest
  MULTISIG_REMOVE_DRAFT_MEMBER: import('./multisig').MultisigDraftMemberRemoveRequest
  MULTISIG_UPDATE_DRAFT_THRESHOLD: import('./multisig').UpdateMultisigDraftThresholdRequest
  MULTISIG_PREDICT_DRAFT: import('./multisig').MultisigDraftIdRequest
  MULTISIG_DEPLOY_DRAFT: import('./multisig').MultisigDraftIdRequest
  MULTISIG_DRAFT_PASSKEY_REG_BEGIN: import('./multisig').MultisigDraftPasskeyRegBeginRequest
  MULTISIG_DRAFT_PASSKEY_REG_FINISH: import('./multisig').MultisigDraftPasskeyRegFinishRequest
  MULTISIG_DRAFT_PASSKEY_AUTH_BEGIN: import('./multisig').MultisigDraftPasskeyRegBeginRequest
  MULTISIG_DRAFT_PASSKEY_AUTH_FINISH: import('./multisig').MultisigDraftPasskeyRegFinishRequest
  MULTISIG_LIST_ACCOUNTS: undefined
  MULTISIG_REGISTER_ACCOUNT: import('./multisig').RegisterMultisigAccountRequest
  MULTISIG_JOIN_PREVIEW: import('./multisig').MultisigJoinTokenRequest
  MULTISIG_JOIN_MEMBER: import('./multisig').MultisigJoinMemberRequest
  MULTISIG_JOIN_PASSKEY_REG_BEGIN: import('./multisig').MultisigJoinPasskeyRegBeginRequest
  MULTISIG_JOIN_PASSKEY_REG_FINISH: import('./multisig').MultisigJoinPasskeyRegFinishRequest
  MULTISIG_JOIN_PASSKEY_AUTH_BEGIN: import('./multisig').MultisigJoinPasskeyRegBeginRequest
  MULTISIG_JOIN_PASSKEY_AUTH_FINISH: import('./multisig').MultisigJoinPasskeyRegFinishRequest
  MULTISIG_LIST_PROPOSALS: import('./multisig').ListMultisigProposalsRequest
  MULTISIG_GET_PROPOSAL: import('./multisig').MultisigProposalIdRequest
  MULTISIG_CREATE_PROPOSAL: import('./multisig').CreateMultisigProposalRequest
  MULTISIG_APPROVE_DELEGATED_BEGIN: import('./multisig').MultisigApproveDelegatedBeginRequest
  MULTISIG_APPROVE_DELEGATED_FINISH: import('./multisig').MultisigApproveDelegatedFinishRequest
  MULTISIG_APPROVE_WEBAUTHN: import('./multisig').MultisigApproveWebauthnRequest
  MULTISIG_EXECUTE_PROPOSAL: import('./multisig').MultisigProposalIdRequest
  MULTISIG_REFRESH_PROPOSAL: import('./multisig').MultisigProposalIdRequest
  MULTISIG_CREATE_LOCAL_ACCOUNT: import('./multisig').CreateMultisigAccountParams
  MULTISIG_GET_PENDING_INVITES: undefined
  MULTISIG_ADD_PENDING_INVITE: import('./multisig').MultisigPendingInvite
  MULTISIG_REMOVE_PENDING_INVITE: { token: string }
  MULTISIG_GET_DRAFT_META: undefined
  MULTISIG_SET_DRAFT_META: import('./multisig').MultisigDraftMeta
  MULTISIG_CLEAR_DRAFT_META: undefined
  MULTISIG_SYNC_LOCAL_ACCOUNTS: { activateFirstCreated?: boolean }
  MULTISIG_GET_PROPOSALS_BANNER_DISMISSED: undefined
  MULTISIG_DISMISS_PROPOSALS_BANNER: { accountId: string }
  COSIGN_GET_TRANSPORT_PUBKEY: undefined
  COSIGN_DEPLOY_ACCOUNT: import('./cosign').CosignDeployAccountRequest
  COSIGN_POST_JOIN_RELAY: import('./cosign').CosignCompleteMemberJoinRequest
  COSIGN_POLL_JOIN_RELAY: import('./cosign').CosignPollJoinRelayRequest
  COSIGN_SEAL_MEMBER_WCK: import('./cosign').CosignSealMemberWckRequest
  COSIGN_DISCOVER_MEMBERSHIPS: import('./cosign').CosignDiscoverRequest
  COSIGN_LIST_PENDING: import('./cosign').CosignListPendingRequest
  COSIGN_GET_REQUEST: import('./cosign').CosignGetRequestPayload
  COSIGN_PROPOSE: import('./cosign').CosignProposeRequest
  COSIGN_SIGN_REQUEST: import('./cosign').CosignSignRequest
  COSIGN_EXECUTE_REQUEST: import('./cosign').CosignExecuteRequest
  COSIGN_CANCEL_REQUEST: import('./cosign').CosignGetRequestPayload
  COSIGN_GET_WCK_RECORD: { walletRef: string }
  COSIGN_ENSURE_V1_AUTH: { linkedAccountId: string }
  COSIGN_V1_AUTH_CHALLENGE: { linkedAccountId: string }
  COSIGN_V1_AUTH_SIGN_IN: {
    linkedAccountId: string
    wallet: string
    keyType: string
    nonce: string
    response: unknown
  }
  COSIGN_CREATE_LOCAL_ACCOUNT: {
    walletRef: string
    label: string
    threshold: number
    wckRecordId: string
    linkedAccountId: string
    cosignBlindSignerId: string
    accountSaltHex?: string
    membersSnapshot?: import('./cosign').CosignMemberInit[]
  }
  COSIGN_GET_PROPOSALS_BANNER_DISMISSED: undefined
  COSIGN_DISMISS_PROPOSALS_BANNER: { accountId: string }
  COSIGN_RUN_POLL: undefined
  COSIGN_PREDICT_ACCOUNT: {
    threshold: number
    signers: import('./multisig').MultisigSignerInitRequest[]
    accountSaltHex: string
  }
  COSIGN_PREPARE_SIGN: {
    unsignedTxXdr: string
    smartAccountAddress: string
    linkedAccountId: string
  }
  COSIGN_ATTACH_WEBAUTHN_AUTH: {
    unsignedTxXdr: string
    sigDataXdrHex: string
    keyDataHex: string
    contextRuleId: number
    authEntryXdr: string
  }
} & Record<string, unknown>

export type BackgroundResponseDataByType = {
  LOGOUT: undefined
  GET_SETUP_STATE: GetSetupStateResponse
  SET_SETUP_STATE: undefined
  GET_ACCOUNTS: GetAccountsResponse
  SET_ACTIVE_ACCOUNT: undefined
  CREATE_OR_CONNECT_PASSKEY: CreateOrConnectPasskeyResponse & { account: StoredAccount }
  IMPORT_MNEMONIC_ACCOUNT: ImportMnemonicAccountResponse
  UNLOCK_MNEMONIC_VAULT: undefined
  SIGN_DELEGATED_G_AUTH_ENTRY: SignDelegatedGAuthEntryResponse
  BUILD_TX: BuildTxResponse
  BUILD_DELEGATED_TX: BuildDelegatedTxResponse
  SUBMIT_TX_DELEGATED: SubmitTxResponse
  SUBMIT_TX_WEBAUTHN: SubmitTxResponse
  PASSKEY_REG_BEGIN: BackendWebauthnBeginResponse
  PASSKEY_REG_FINISH: BackendWebauthnRegistrationFinishResponse & { account: StoredAccount }
  PASSKEY_AUTH_BEGIN: BackendWebauthnBeginResponse
  PASSKEY_AUTH_FINISH: BackendWebauthnAuthenticationFinishResponse & {
    account: StoredAccount
    accounts: StoredAccount[]
    activeAccountId?: string
  }
  GET_BACKEND_ACCOUNTS: BackendAccountsResponse
  RENAME_ACCOUNT: undefined
  GET_DAPP_PERMISSIONS: GetDappPermissionsResponse
  SET_DAPP_PERMISSIONS: GetDappPermissionsResponse
  LIST_PENDING_DAPP_REQUESTS: ListPendingDappRequestsResponse
  RESOLVE_PENDING_DAPP_REQUEST: undefined
  DAPP_GET_PUBLIC_KEY: DappGetPublicKeyResponse
  DAPP_SIGN_TRANSACTION: DappSignTransactionResponse
  DAPP_OPEN_SIGN_REQUEST: undefined
  MIGRATION_DISCOVER: MigrationDiscovery
  MIGRATION_SWEEP_XLM: MigrationSweepResult
  MIGRATION_SWEEP_TOKEN: MigrationSweepResult
  GET_SMART_ACCOUNT_BALANCES: GetSmartAccountBalancesResponse
  GET_SMART_ACCOUNT_TRANSACTIONS: GetSmartAccountTransactionsResponse
  GET_MARKET_PRICES: GetMarketPricesResponse
  CREATE_DEPOSIT_INTENT: DepositIntent
  GET_DEPOSIT_INTENT_STATUS: DepositStatus
  GET_ASSET_ICON_DATA_URLS: GetAssetIconDataUrlsResponse
  BUILD_SEND_TX: BuildSendTxResponse
  SETUP_SEND_RULES: SetupSendRulesResponse
  OPEN_WALLET_AFTER_ONBOARDING: undefined
  OPEN_ONBOARDING_TAB: undefined
  PREPARE_EXTERNAL_SIGN: import('./externalSign').RunExternalSignFlowPreparedResponse
  RUN_EXTERNAL_SIGN_FLOW: import('./externalSign').ExternalSignResult
  GET_ACTIVE_NETWORK: { network: Network; networkLabel: string }
  SET_ACTIVE_NETWORK: { network: Network; networkLabel: string }
  PING_EXTENSION: { connected: true }
  CANCEL_REQUEST: undefined
  GET_SWAP_TOKEN_CATALOG: import('./swap').GetSwapTokenCatalogResponse
  GET_SWAP_QUOTE: import('./swap').GetSwapQuoteResponse
  PREPARE_SWAP_TX: import('./swap').PrepareSwapTxResponse
  SETUP_SWAP_RULES: import('./swap').SetupSwapRulesResponse
  RECORD_KNOWN_SAC_PROBE: undefined
  MULTISIG_CREATE_DRAFT: import('./multisig').CreateMultisigDraftResponse
  MULTISIG_GET_ACTIVE_DRAFT: import('./multisig').GetActiveMultisigDraftResponse
  MULTISIG_ADD_DRAFT_MEMBER: import('./multisig').MultisigDraft
  MULTISIG_REMOVE_DRAFT_MEMBER: import('./multisig').MultisigDraft
  MULTISIG_UPDATE_DRAFT_THRESHOLD: import('./multisig').MultisigDraft
  MULTISIG_PREDICT_DRAFT: import('./multisig').MultisigPredictResponse
  MULTISIG_DEPLOY_DRAFT: import('./multisig').MultisigDeployResponse
  MULTISIG_DRAFT_PASSKEY_REG_BEGIN: BackendWebauthnBeginResponse
  MULTISIG_DRAFT_PASSKEY_REG_FINISH: import('./multisig').MultisigDraftPasskeyRegFinishResponse
  MULTISIG_DRAFT_PASSKEY_AUTH_BEGIN: BackendWebauthnBeginResponse
  MULTISIG_DRAFT_PASSKEY_AUTH_FINISH: import('./multisig').MultisigDraftPasskeyRegFinishResponse
  MULTISIG_LIST_ACCOUNTS: import('./multisig').ListMultisigAccountsResponse
  MULTISIG_REGISTER_ACCOUNT: import('./multisig').MultisigAccount
  MULTISIG_JOIN_PREVIEW: import('./multisig').MultisigJoinPreviewResponse
  MULTISIG_JOIN_MEMBER: import('./multisig').MultisigDraft
  MULTISIG_JOIN_PASSKEY_REG_BEGIN: BackendWebauthnBeginResponse
  MULTISIG_JOIN_PASSKEY_REG_FINISH: import('./multisig').MultisigDraftPasskeyRegFinishResponse
  MULTISIG_JOIN_PASSKEY_AUTH_BEGIN: BackendWebauthnBeginResponse
  MULTISIG_JOIN_PASSKEY_AUTH_FINISH: import('./multisig').MultisigDraftPasskeyRegFinishResponse
  MULTISIG_LIST_PROPOSALS: import('./multisig').ListMultisigProposalsResponse
  MULTISIG_GET_PROPOSAL: import('./multisig').MultisigProposalDetail
  MULTISIG_CREATE_PROPOSAL: import('./multisig').CreateMultisigProposalResponse
  MULTISIG_APPROVE_DELEGATED_BEGIN: Record<string, unknown>
  MULTISIG_APPROVE_DELEGATED_FINISH: import('./multisig').MultisigProposalDetail
  MULTISIG_APPROVE_WEBAUTHN: import('./multisig').MultisigProposalDetail
  MULTISIG_EXECUTE_PROPOSAL: import('./multisig').MultisigExecuteProposalResponse
  MULTISIG_REFRESH_PROPOSAL: import('./multisig').MultisigProposalDetail
  MULTISIG_CREATE_LOCAL_ACCOUNT: { account: StoredAccount; activeAccountId?: string }
  MULTISIG_GET_PENDING_INVITES: { invites: import('./multisig').MultisigPendingInvite[] }
  MULTISIG_ADD_PENDING_INVITE: { invites: import('./multisig').MultisigPendingInvite[] }
  MULTISIG_REMOVE_PENDING_INVITE: { invites: import('./multisig').MultisigPendingInvite[] }
  MULTISIG_GET_DRAFT_META: { meta: import('./multisig').MultisigDraftMeta | null }
  MULTISIG_SET_DRAFT_META: undefined
  MULTISIG_CLEAR_DRAFT_META: undefined
  MULTISIG_SYNC_LOCAL_ACCOUNTS: {
    accounts: StoredAccount[]
    activeAccountId?: string
    created: StoredAccount[]
    updated: boolean
  }
  MULTISIG_GET_PROPOSALS_BANNER_DISMISSED: { accountIds: string[] }
  MULTISIG_DISMISS_PROPOSALS_BANNER: { accountIds: string[] }
  COSIGN_GET_TRANSPORT_PUBKEY: import('./cosign').CosignGetTransportPubkeyResponse
  COSIGN_DEPLOY_ACCOUNT: import('./cosign').CosignDeployAccountResponse
  COSIGN_POST_JOIN_RELAY: { message: string }
  COSIGN_POLL_JOIN_RELAY: import('./cosign').JoinRelayRecord | null
  COSIGN_SEAL_MEMBER_WCK: { message: string }
  COSIGN_DISCOVER_MEMBERSHIPS: import('./cosign').CosignDiscoverResponse
  COSIGN_LIST_PENDING: import('./cosign').CosignListPendingResponse
  COSIGN_GET_REQUEST: import('./cosign').CosignRequest
  COSIGN_PROPOSE: import('./cosign').CosignRequest
  COSIGN_SIGN_REQUEST: import('./cosign').CosignRequest
  COSIGN_EXECUTE_REQUEST: import('./cosign').CosignExecuteResponse
  COSIGN_CANCEL_REQUEST: { message: string }
  COSIGN_GET_WCK_RECORD: import('./cosign').CosignWalletRecord | null
  COSIGN_ENSURE_V1_AUTH: { ok: true }
  COSIGN_V1_AUTH_CHALLENGE: { wallet: string; nonce: string; keyType: string }
  COSIGN_V1_AUTH_SIGN_IN: { ok: true }
  COSIGN_CREATE_LOCAL_ACCOUNT: { account: StoredAccount; activeAccountId?: string }
  COSIGN_GET_PROPOSALS_BANNER_DISMISSED: { accountIds: string[] }
  COSIGN_DISMISS_PROPOSALS_BANNER: { accountIds: string[] }
  COSIGN_RUN_POLL: { notified: number }
  COSIGN_PREDICT_ACCOUNT: import('./multisig').MultisigPredictResponse
  COSIGN_PREPARE_SIGN: import('./index').PrepareSignResponse
  COSIGN_ATTACH_WEBAUTHN_AUTH: { signedAuthEntryBase64: string }
} & Record<string, unknown>

export interface CreateMultisigAccountResponse {
  account: StoredAccount
  activeAccountId?: string
}

export * from './externalSign'
export * from './swap'
export * from './multisig'
export * from './cosign'
