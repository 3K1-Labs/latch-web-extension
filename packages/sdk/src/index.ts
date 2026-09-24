/**
 * @latch/sdk
 * Public dapp-facing extension API — the `window.latch` surface.
 *
 * This is the ONLY interface dapps interact with.
 * It communicates with the content script, which proxies to the background SW.
 *
 * Pattern: mirrors @stellar/freighter-api — a clean public package
 * that hides all internal wallet complexity from dapp developers.
 */

import type {
  Network,
  OpenSignRequestParams,
  Sep0043GetAddressResponse,
  Sep0043GetNetworkResponse,
  Sep0043SignTransactionOptions,
  Sep0043SignTransactionResponse,
  SignTransactionRequest,
  SignTransactionResponse,
} from '@latch/types'

import type { LatchPublicMethod } from './publicSurface'

export type LatchAccountChangedPayload = {
  publicKey: string
  network: Network
}

export type LatchProviderEventName = 'accountChanged' | 'networkChanged'

export interface LatchSDK {
  /** Returns true if the Latch extension is installed and accessible */
  isConnected(): Promise<boolean>

  /** Request the user's smart-account address as a plain string. */
  getPublicKey(): Promise<string>

  /** Request the user to sign an XDR-encoded transaction. */
  signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>
  signTransaction(
    xdr: string,
    opts?: Sep0043SignTransactionOptions
  ): Promise<Sep0043SignTransactionResponse>

  /** Open the extension's review flow for an externally prepared signing request */
  openSignRequest(params: OpenSignRequestParams): Promise<void>

  /** Returns the active network */
  getNetwork(): Promise<Network>

  getAddress(): Promise<Sep0043GetAddressResponse>
  getNetworkDetails(): Promise<Sep0043GetNetworkResponse>

  /**
   * Revoke Latch access for the current origin. The next `getPublicKey()` /
   * `getAddress()` prompts the user again. Accounts and other origins are
   * untouched, and Latch emits no event — clear your own session state.
   */
  disconnect(): Promise<void>

  /** Subscribe to active account / network changes */
  on?(event: LatchProviderEventName, handler: (payload: LatchAccountChangedPayload) => void): void

  off?(event: LatchProviderEventName, handler: (payload: LatchAccountChangedPayload) => void): void
}

declare global {
  interface Window {
    latch?: {
      isConnected(): Promise<boolean>
      getPublicKey(): Promise<string>
      signTransaction(
        requestOrXdr: SignTransactionRequest | string,
        opts?: Sep0043SignTransactionOptions
      ): Promise<SignTransactionResponse | Sep0043SignTransactionResponse>
      openSignRequest(params: OpenSignRequestParams): Promise<void>
      getNetwork(): Promise<Network>
      getAddress(): Promise<Sep0043GetAddressResponse>
      getNetworkDetails(): Promise<Sep0043GetNetworkResponse>
      disconnect?(): Promise<void>
      on?(
        event: LatchProviderEventName,
        handler: (payload: LatchAccountChangedPayload) => void
      ): void
      off?(
        event: LatchProviderEventName,
        handler: (payload: LatchAccountChangedPayload) => void
      ): void
    }
  }
}

async function signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>
async function signTransaction(
  xdr: string,
  opts?: Sep0043SignTransactionOptions
): Promise<Sep0043SignTransactionResponse>
async function signTransaction(
  requestOrXdr: SignTransactionRequest | string,
  opts?: Sep0043SignTransactionOptions
): Promise<SignTransactionResponse | Sep0043SignTransactionResponse> {
  return await requireLatch().signTransaction(requestOrXdr as SignTransactionRequest & string, opts)
}

function requireLatch(): NonNullable<Window['latch']> {
  if (typeof window === 'undefined')
    throw new Error('Latch SDK must be used in a browser environment')
  if (!window.latch) throw new Error('Latch extension not detected')
  return window.latch
}

export function getLatchSDK(): LatchSDK {
  return {
    async isConnected() {
      return await requireLatch().isConnected()
    },
    async getPublicKey() {
      return await requireLatch().getPublicKey()
    },
    signTransaction,
    async openSignRequest(params: OpenSignRequestParams) {
      return await requireLatch().openSignRequest(params)
    },
    async getNetwork() {
      return await requireLatch().getNetwork()
    },
    async getAddress() {
      return await requireLatch().getAddress()
    },
    async getNetworkDetails() {
      return await requireLatch().getNetworkDetails()
    },
    async disconnect() {
      const latch = requireLatch()
      // Older extension builds have no disconnect; treat teardown as a no-op.
      if (!latch.disconnect) return
      await latch.disconnect()
    },
    on(event, handler) {
      requireLatch().on?.(event, handler)
    },
    off(event, handler) {
      requireLatch().off?.(event, handler)
    },
  }
}

export default getLatchSDK

/** Compile-time: LatchSDK / Window['latch'] keys must equal LATCH_PUBLIC_METHODS. */
type ExpectEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const _assertPublicSurface: {
  sdk: ExpectEqual<keyof LatchSDK, LatchPublicMethod>
  windowLatch: ExpectEqual<keyof NonNullable<Window['latch']>, LatchPublicMethod>
} = { sdk: true, windowLatch: true }
void _assertPublicSurface

export { LATCH_PUBLIC_METHODS } from './publicSurface'
export type { LatchPublicMethod } from './publicSurface'

export {
  LatchModule,
  LATCH_MODULE_ICON,
  LATCH_MODULE_ID,
  LATCH_MODULE_URL,
} from './stellar-wallets-kit'
export type { StellarWalletsKitModule, WalletKitNetworkOptions } from './stellar-wallets-kit'

export type {
  OpenSignRequestParams,
  Sep0043GetAddressResponse,
  Sep0043GetNetworkResponse,
  Sep0043SignTransactionOptions,
  Sep0043SignTransactionResponse,
  Sep0043Error,
  Sep0043ErrorCode,
} from '@latch/types'
