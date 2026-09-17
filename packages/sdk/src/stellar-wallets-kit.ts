import type { LatchSDK } from './index'
import type { Network, SignTransactionRequest, SignTransactionResponse } from '@latch/types'

type IOnChangeEvent = {
  address: string
  network: string
  networkPassphrase: string
}

/** Structural copy of the kit contract, kept type-only so the SDK has no kit runtime dependency. */
interface ModuleInterface {
  moduleType: 'HOT_WALLET'
  productIcon: string
  productId: string
  productName: string
  productUrl: string
  isAvailable(): Promise<boolean>
  getAddress(params?: { path?: string; skipRequestAccess?: boolean }): Promise<{ address: string }>
  signTransaction(
    xdr: string,
    opts?: WalletKitNetworkOptions
  ): Promise<{ signedTxXdr: string; signerAddress?: string }>
  signAuthEntry(
    authEntry: string,
    opts?: WalletKitNetworkOptions
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }>
  signMessage(
    message: string,
    opts?: WalletKitNetworkOptions
  ): Promise<{ signedMessage: string; signerAddress?: string }>
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>
  onChange(callback: (event: IOnChangeEvent) => void): void
  disconnect?(): Promise<void>
}

export const LATCH_MODULE_ID = 'latch'
export const LATCH_MODULE_URL = 'https://latch.tech/'
export const LATCH_MODULE_ICON =
  'https://raw.githubusercontent.com/3K1-Labs/latch-web-extension/main/apps/extension/assets/brand/latch-logo.svg'

export type WalletKitNetworkOptions = {
  networkPassphrase?: string
  address?: string
  path?: string
}

/** Public alias to the kit's real module contract for downstream consumers. */
export type StellarWalletsKitModule = ModuleInterface

const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'

function networkFromPassphrase(passphrase?: string): Network {
  return passphrase === PUBLIC_PASSPHRASE ? 'mainnet' : 'testnet'
}

function passphraseFromNetwork(network: Network): string {
  return network === 'mainnet' ? PUBLIC_PASSPHRASE : TESTNET_PASSPHRASE
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Latch availability check timed out')), timeoutMs)
  })

  return Promise.race([promise, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout)
  })
}

type LatchModuleSDK = Pick<
  LatchSDK,
  'isConnected' | 'getPublicKey' | 'getNetwork' | 'openSignRequest' | 'disconnect' | 'on' | 'off'
> & {
  signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>
}

function defaultSDK(): LatchModuleSDK {
  if (typeof window === 'undefined' || !window.latch) {
    throw new Error('Latch extension not detected')
  }
  return {
    isConnected: () => window.latch!.isConnected(),
    getPublicKey: () => window.latch!.getPublicKey(),
    signTransaction: (request) => window.latch!.signTransaction(request),
    openSignRequest: (params) => window.latch!.openSignRequest(params),
    getNetwork: () => window.latch!.getNetwork(),
    disconnect: async () => {
      await window.latch!.disconnect?.()
    },
    on: (event, handler) => window.latch!.on?.(event, handler),
    off: (event, handler) => window.latch!.off?.(event, handler),
  }
}

/** Latch adapter for the Stellar Wallets Kit ModuleInterface. */
export class LatchModule implements ModuleInterface {
  readonly moduleType = 'HOT_WALLET' as const
  readonly productIcon = LATCH_MODULE_ICON
  readonly productId = LATCH_MODULE_ID
  readonly productName = 'Latch'
  readonly productUrl = LATCH_MODULE_URL

  private sdkInstance?: LatchModuleSDK

  constructor(sdk?: LatchModuleSDK) {
    this.sdkInstance = sdk
  }

  private get sdk(): LatchModuleSDK {
    return (this.sdkInstance ??= defaultSDK())
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await withTimeout(this.sdk.isConnected(), 900)
    } catch {
      return false
    }
  }

  async getAddress(_params?: {
    path?: string
    skipRequestAccess?: boolean
  }): Promise<{ address: string }> {
    return { address: await this.sdk.getPublicKey() }
  }

  async signTransaction(
    xdr: string,
    opts: WalletKitNetworkOptions = {}
  ): Promise<{ signedTxXdr: string; signerAddress?: string }> {
    const network = networkFromPassphrase(opts.networkPassphrase)
    const address = opts.address ?? (await this.sdk.getPublicKey())
    const response = await this.sdk.signTransaction({
      xdr,
      network,
      accountToSign: address,
      submit: false,
    })
    const signedTxXdr = response.signedTxXdr ?? response.signedXdr
    if (!signedTxXdr) throw new Error('Latch returned no signed transaction XDR')
    return { signedTxXdr, signerAddress: address }
  }

  async signAuthEntry(
    _authEntry: string,
    _opts?: WalletKitNetworkOptions
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }> {
    throw new Error('Latch does not support signAuthEntry yet')
  }

  async signMessage(
    _message: string,
    _opts?: WalletKitNetworkOptions
  ): Promise<{ signedMessage: string; signerAddress?: string }> {
    throw new Error('Latch does not support signMessage yet')
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const network = await this.sdk.getNetwork()
    return { network, networkPassphrase: passphraseFromNetwork(network) }
  }

  onChange(callback: (event: IOnChangeEvent) => void): void {
    const handler = (payload: { publicKey: string; network: Network }) => {
      callback({
        address: payload.publicKey,
        network: payload.network,
        networkPassphrase: passphraseFromNetwork(payload.network),
      })
    }
    this.sdk.on?.('accountChanged', handler)
    this.sdk.on?.('networkChanged', handler)
  }

  async disconnect(): Promise<void> {
    // Revokes the origin allowlist so the kit's "Disconnect" drops wallet access.
    await this.sdk.disconnect()
  }
}

export default LatchModule
