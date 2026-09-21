/**
 * Page-context provider — sets `window.latch` via a <script> tag injected by provider-bridge.
 * Must not use chrome.* APIs; talks to the isolated bridge via postMessage only.
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

import {
  buildSep0043NetworkResponse,
  buildSepSignRequest,
  mapNativeSignResponseToSep,
  passphraseToNetwork,
  toSep0043Error,
} from './sep0043'

const LATCH_PROVIDER_REQUEST = 'LATCH_PROVIDER_REQUEST'
const LATCH_PROVIDER_RESPONSE = 'LATCH_PROVIDER_RESPONSE'
const LATCH_PROVIDER_EVENT = 'LATCH_PROVIDER_EVENT'
export const LATCH_PROVIDER_MARK = '__latchPostMessageBridge_v1'

class LatchProviderError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'LatchProviderError'
    this.code = code
  }
}

type BridgeResponse<T> = {
  source: typeof LATCH_PROVIDER_RESPONSE
  messageId: number
  ok: boolean
  data?: T
  error?: { message: string; code?: string }
}

type ProviderEventName = 'accountChanged' | 'networkChanged'

type ProviderEventPayload = {
  publicKey: string
  network: Network
}

type ProviderEventMessage = {
  source: typeof LATCH_PROVIDER_EVENT
  event: ProviderEventName
  data: ProviderEventPayload
}

type ProviderEventHandler = (payload: ProviderEventPayload) => void

async function sendToBackground<TData>(method: string, payload: unknown): Promise<TData> {
  const messageId = Date.now() + Math.random()

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new LatchProviderError('Latch extension timeout', 'timeout'))
    }, 120_000)

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return
      const data = event.data as BridgeResponse<TData>
      if (!data || data.source !== LATCH_PROVIDER_RESPONSE) return
      if (data.messageId !== messageId) return

      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)

      if (data.ok) {
        resolve(data.data as TData)
        return
      }
      reject(
        new LatchProviderError(data.error?.message ?? 'Latch request failed', data.error?.code)
      )
    }

    window.addEventListener('message', onMessage, false)
    window.postMessage(
      {
        source: LATCH_PROVIDER_REQUEST,
        messageId,
        method,
        payload,
      },
      window.location.origin
    )
  })
}

async function sendToBackgroundWithTimeout<TData>(
  method: string,
  payload: unknown,
  timeoutMs = 2000
): Promise<TData> {
  return await Promise.race([
    sendToBackground<TData>(method, payload),
    new Promise<TData>((_, reject) => {
      window.setTimeout(
        () => reject(new LatchProviderError('Latch extension timeout', 'timeout')),
        timeoutMs
      )
    }),
  ])
}

async function fetchActivePublicKey(): Promise<string> {
  const data = await sendToBackground<{ publicKey: string }>('getPublicKey', {
    origin: window.location.origin,
  })
  return data.publicKey
}

async function fetchActiveNetwork(): Promise<Network> {
  const data = await sendToBackground<{ network: Network }>('getNetwork', {})
  return data.network
}

interface LatchProvider {
  isConnected(): Promise<boolean>
  getPublicKey(): Promise<string>
  getNetwork(): Promise<Network>
  signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>
  signTransaction(
    xdr: string,
    opts?: Sep0043SignTransactionOptions
  ): Promise<Sep0043SignTransactionResponse>
  getAddress(): Promise<Sep0043GetAddressResponse>
  getNetworkDetails(): Promise<Sep0043GetNetworkResponse>
  openSignRequest(params: OpenSignRequestParams): Promise<void>
  disconnect(): Promise<void>
  on(event: ProviderEventName, handler: ProviderEventHandler): void
  off(event: ProviderEventName, handler: ProviderEventHandler): void
  [LATCH_PROVIDER_MARK]?: true
}

function installLatch() {
  const w = window as Window & { latch?: LatchProvider }
  if (w.latch?.[LATCH_PROVIDER_MARK]) return

  const emitter = new EventTarget()
  const handlerMap = new WeakMap<ProviderEventHandler, EventListener>()

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return
    const data = event.data as ProviderEventMessage
    if (!data || data.source !== LATCH_PROVIDER_EVENT) return
    if (data.event !== 'accountChanged' && data.event !== 'networkChanged') return
    if (!data.data?.publicKey) return
    emitter.dispatchEvent(
      new CustomEvent(data.event, {
        detail: {
          publicKey: data.data.publicKey,
          network: data.data.network,
        } satisfies ProviderEventPayload,
      })
    )
  })

  const latch: LatchProvider = {
    [LATCH_PROVIDER_MARK]: true,
    async isConnected() {
      try {
        await sendToBackgroundWithTimeout('ping', {})
        return true
      } catch {
        return false
      }
    },
    async getPublicKey() {
      return await fetchActivePublicKey()
    },
    async signTransaction(
      requestOrXdr: SignTransactionRequest | string,
      opts?: Sep0043SignTransactionOptions
    ): Promise<SignTransactionResponse | Sep0043SignTransactionResponse> {
      if (typeof requestOrXdr === 'string') {
        try {
          const networkFromPassphrase = passphraseToNetwork(opts?.networkPassphrase)
          const network = networkFromPassphrase ?? (await fetchActiveNetwork())
          const activeAddress = await fetchActivePublicKey()
          const nativeRequest = buildSepSignRequest({
            xdr: requestOrXdr,
            opts,
            activeAddress,
            network,
          })

          const data = await sendToBackground<{ response: SignTransactionResponse }>(
            'signTransaction',
            {
              origin: window.location.origin,
              request: nativeRequest,
            }
          )

          return mapNativeSignResponseToSep(data.response, nativeRequest.accountToSign)
        } catch (err) {
          throw toSep0043Error(err)
        }
      }

      const data = await sendToBackground<{ response: SignTransactionResponse }>(
        'signTransaction',
        {
          origin: window.location.origin,
          request: requestOrXdr,
        }
      )
      return data.response
    },
    async getNetwork() {
      return await fetchActiveNetwork()
    },
    async getAddress() {
      try {
        const address = await fetchActivePublicKey()
        return { address }
      } catch (err) {
        throw toSep0043Error(err)
      }
    },
    async getNetworkDetails() {
      try {
        const network = await fetchActiveNetwork()
        return buildSep0043NetworkResponse(network)
      } catch (err) {
        throw toSep0043Error(err)
      }
    },
    async openSignRequest(params: OpenSignRequestParams) {
      await sendToBackground('openSignRequest', {
        origin: window.location.origin,
        request: {
          network: params.network,
          smartAccountAddress: params.account,
          unsignedTxXdr: params.xdr,
          payloadRef: params.payloadRef,
          callback: params.callback,
          requestId: params.requestId,
          submit: params.submit,
          origin: params.origin ?? window.location.origin,
        },
      })
    },
    async disconnect() {
      // Revokes this origin's allowlist entry only. Latch emits no event; the
      // dapp clears its own session once this resolves.
      await sendToBackground('disconnect', {
        origin: window.location.origin,
      })
    },
    on(event, handler) {
      const listener: EventListener = (ev) => {
        const detail = (ev as CustomEvent<ProviderEventPayload>).detail
        handler(detail)
      }
      handlerMap.set(handler, listener)
      emitter.addEventListener(event, listener)
    },
    off(event, handler) {
      const listener = handlerMap.get(handler)
      if (!listener) return
      emitter.removeEventListener(event, listener)
      handlerMap.delete(handler)
    },
  }

  w.latch = latch
}

installLatch()
