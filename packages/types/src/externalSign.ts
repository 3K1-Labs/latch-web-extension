import type { BuildSendTxResponse, Network, SendSignerType } from './index'

export interface PreparedSignOperation {
  type: string
  summary: string
  details?: Record<string, string>
}

/** One call in a Soroban auth entry's invocation tree. */
export interface AuthTreeNode {
  kind: 'contract_fn' | 'create_contract' | 'unknown'
  /** C… address for `contract_fn`. */
  contractId?: string
  functionName?: string
  depth: number
}

/** What one prepared auth entry authorizes. `selfCall`: it calls the wallet itself or can't be read. */
export interface ExternalSignAuthTreeEntry {
  entryIndex: number
  nodes: AuthTreeNode[]
  selfCall: boolean
}

/** Wallet-decoded review of the dApp unsigned XDR (hybrid external-sign review). */
export interface ExternalSignLocalReview {
  operations: PreparedSignOperation[]
  invokeContractIds: string[]
  confirmBlocked: boolean
  confirmBlockedReason: string | null
  code?:
    | 'unparsable_xdr'
    | 'network_mismatch'
    | 'account_mismatch'
    | 'contract_mismatch'
    | 'user_mismatch'
    | 'self_admin_call'
  /** Non-blocking cautions from the local decode (e.g. a fee token other than XLM or USDC). */
  warnings?: string[]
  /** Auth entries that get signed. Optional: requests stored before this field existed lack it. */
  authTree?: ExternalSignAuthTreeEntry[]
}

export interface PrepareSignRequest {
  network: Network
  smartAccountAddress: string
  unsignedTxXdr: string
  signerType?: SendSignerType
  signerG?: string
  /** Signing passkey's key data; selects that passkey's context rule on backup-signer accounts. */
  keyDataHex?: string
  /** Bundler public G when tx source is fee-payer; delegated entry synthesis only. */
  feePayerG?: string
}

/** Extends BuildSendTxResponse with review metadata from prepare-sign. */
export interface PrepareSignResponse extends BuildSendTxResponse {
  network: Network
  smartAccountAddress: string
  operations?: PreparedSignOperation[]
  warnings?: string[]
  delegatedGAuthEntrySynthesized?: boolean
  submitMethod?: 'webauthn' | 'delegated' | 'bundler-delegated'
}

export interface ExternalSignRequest {
  network: Network
  smartAccountAddress: string
  unsignedTxXdr?: string
  payloadRef?: string
  callback?: string
  requestId?: string
  submit?: boolean
  origin?: string
}

export type ExternalSignSource = 'provider' | 'sign-request-tab'

export type ExternalSignStatus = 'signed' | 'rejected' | 'error'

export interface ExternalSignResult {
  status: ExternalSignStatus
  txHash?: string
  signedAuthEntry?: string
  signedTxXdr?: string
  code?: string
  message?: string
  requestId?: string
  network?: Network
}

export interface SignCallbackResult {
  requestId?: string
  status: ExternalSignStatus
  txHash?: string
  network?: Network
  code?: string
  message?: string
}

export interface SignPayloadStoreResponse {
  network: Network
  smartAccountAddress: string
  unsignedTxXdr: string
  callback: string
  requestId?: string
  origin?: string
  submit?: boolean
}

export interface RunExternalSignFlowRequest {
  source: ExternalSignSource
  request: ExternalSignRequest
}

export interface RunExternalSignFlowPreparedResponse {
  requestId: string
  origin: string
  signRequest: ExternalSignRequest
  prepared: PrepareSignResponse
  localReview: ExternalSignLocalReview
}

/** Params for window.latch.openSignRequest (Layer 2 without chrome-extension:// redirect). */
export interface OpenSignRequestParams {
  network: Network
  /** Smart account C-address */
  account: string
  callback: string
  requestId: string
  /** Standard base64 unsigned tx XDR */
  xdr?: string
  payloadRef?: string
  submit?: boolean
  origin?: string
}

export interface DappOpenSignRequestPayload {
  origin: string
  request: ExternalSignRequest
}

export enum LATCH_EXTERNAL_SERVICE_TYPES {
  REQUEST_CONNECTION_STATUS = 'REQUEST_CONNECTION_STATUS',
  REQUEST_ACCESS = 'REQUEST_ACCESS',
  REQUEST_PUBLIC_KEY = 'REQUEST_PUBLIC_KEY',
  REQUEST_NETWORK = 'REQUEST_NETWORK',
  SUBMIT_TRANSACTION = 'SUBMIT_TRANSACTION',
}

/** Payload for window.latch on('accountChanged' | 'networkChanged'). */
export type LatchProviderEventName = 'accountChanged' | 'networkChanged'

export interface LatchAccountChangedPayload {
  publicKey: string
  network: Network
}

/** Background → content-script → page event bridge message. */
export interface LatchProviderEventMessage {
  type: 'LATCH_PROVIDER_EVENT'
  event: LatchProviderEventName
  data: LatchAccountChangedPayload
}
