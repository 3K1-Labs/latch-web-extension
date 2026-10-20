/**
 * dApp-facing types published with `@uselatch/sdk`.
 * Kept local so the npm package does not depend on private `@latch/types`.
 * Drift against the monorepo copies is checked in `publicTypes.drift.test.ts`.
 */

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
