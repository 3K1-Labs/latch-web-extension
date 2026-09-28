import type {
  BuildSendTxResponse,
  Network,
  PrepareSignResponse,
  SendSignerType,
  SetupSendRulesResponse,
} from './index'

/** Swap token row for UI + quote requests. */
export interface SwapTokenRow {
  id: string
  symbol: string
  name: string
  assetId: string
  contractId: string
  decimals: number
  balance: string
  issuer?: string
  iconUrl?: string | null
}

/** Serializable quote returned to UI (includes build payload for prepare step). */
export interface SwapQuotePayload {
  providerId: string
  providerName: string
  amountInRaw: string
  amountOutRaw: string
  amountOutMinRaw: string
  pathLabels: string[]
  pools?: string[]
  expiresAtMs: number
  slippageBps: number
  assetIn: SwapTokenRow
  assetOut: SwapTokenRow
  buildPayload: Record<string, unknown>
}

export interface GetSwapTokenCatalogRequest {
  accountId: string
}

export interface GetSwapTokenCatalogResponse {
  payTokens: SwapTokenRow[]
  receiveTokens: SwapTokenRow[]
  preferredReceiveTokenIds: string[]
}

export interface GetSwapQuoteRequest {
  accountId: string
  assetInId: string
  assetOutId: string
  amountIn: string
  slippageBps?: number
  providerId?: string
  /** Optional per-view id; UI sends CANCEL_REQUEST with the same id to detach the waiter. */
  requestId?: string
}

export interface GetSwapQuoteResponse {
  quote: SwapQuotePayload
}

export interface PrepareSwapTxRequest {
  accountId: string
  quote: SwapQuotePayload
}

export interface BuildSwapTxRequest {
  network: Network
  smartAccountAddress: string
  signerType: SendSignerType
  signerG?: string
  /** Signing passkey's key data; selects that passkey's context rule on backup-signer accounts. */
  keyDataHex?: string
  routerContractId: string
  swapChainXdr: string
  tokenInContractId: string
  amountInRaw: string
  amountOutMinRaw: string
  providerId?: string
}

export type BuildSwapTxResponse = BuildSendTxResponse & {
  routerContractId?: string
  tokenInContractId?: string
  providerId?: string
}

export type PrepareSwapTxResponse = PrepareSignResponse | BuildSwapTxResponse

export interface SetupSwapRulesRequest {
  smartAccountAddress: string
  signerType: SendSignerType
  network: Network
  providerId?: string
  routerContractId?: string
  publicKeyHex?: string
  verifierAddress?: string
  keyDataHex?: string
  credentialId?: string
  gAddress?: string
}

export type SetupSwapRulesResponse = SetupSendRulesResponse & {
  routerContractId?: string
}
