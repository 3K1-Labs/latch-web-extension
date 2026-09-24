/**
 * Isolated-world bridge: injects the page provider and forwards postMessage
 * to the background service worker (page context cannot use chrome.* APIs).
 *
 * Security: only public dapp methods are accepted. Page-supplied MessageTypes
 * are ignored; origin is pinned to window.location.origin.
 */

import type { PlasmoCSConfig } from 'plasmo'

import type { LatchProviderEventMessage, Network } from '@latch/types'

import { handleProviderBridgeRequest } from './providerBridgeRequest'
import inpageUrl from 'url:../scripts/inpage.ts'

export const config: PlasmoCSConfig = {
  matches: ['<all_urls>'],
  run_at: 'document_start',
}

const LATCH_PROVIDER_REQUEST = 'LATCH_PROVIDER_REQUEST'
const LATCH_PROVIDER_RESPONSE = 'LATCH_PROVIDER_RESPONSE'
const LATCH_PROVIDER_EVENT = 'LATCH_PROVIDER_EVENT'

const ACCOUNTS_KEY = 'latch.accounts'
const ACTIVE_ACCOUNT_ID_KEY = 'latch.activeAccountId'
const DISCONNECTED_ORIGINS_KEY = 'latch.dappDisconnectedOrigins'

type ProviderBridgeMessage = {
  source: typeof LATCH_PROVIDER_REQUEST
  messageId: number
  /** Public method name (preferred). Page-supplied MessageType `type` is ignored. */
  method?: unknown
  /** Legacy/internal field — never trusted from the page. */
  type?: unknown
  payload?: unknown
}

type BgRes<T> = { ok: boolean; data?: T; error?: { message: string; code?: string } }

type StoredAccountRow = { id: string; smartAccountAddress?: string }

function injectInpageProvider(): void {
  const root = document.documentElement
  if (root.dataset.latchInpage === '1') return
  root.dataset.latchInpage = '1'

  const script = document.createElement('script')
  script.src = inpageUrl
  script.async = false
  ;(document.head || root).prepend(script)
}

function postProviderEvent(message: LatchProviderEventMessage): void {
  window.postMessage(
    {
      source: LATCH_PROVIDER_EVENT,
      event: message.event,
      data: message.data,
    },
    window.location.origin
  )
}

async function emitActiveAccountFromStorage(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([ACCOUNTS_KEY, ACTIVE_ACCOUNT_ID_KEY])
    const accounts = (stored[ACCOUNTS_KEY] as StoredAccountRow[] | undefined) ?? []
    const activeAccountId = stored[ACTIVE_ACCOUNT_ID_KEY] as string | undefined
    const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0]
    const publicKey = active?.smartAccountAddress?.trim()
    if (!publicKey) return

    let network: Network = 'testnet'
    try {
      const netRes = (await chrome.runtime.sendMessage({
        type: 'GET_ACTIVE_NETWORK',
        payload: {},
      })) as BgRes<{ network: Network }>
      if (netRes?.ok && netRes.data?.network) network = netRes.data.network
    } catch (e) {
      // keep testnet default — still emit accountChanged
      console.error('[latch:provider-bridge] get-active-network', e)
    }

    postProviderEvent({
      type: 'LATCH_PROVIDER_EVENT',
      event: 'accountChanged',
      data: { publicKey, network },
    })
  } catch (e) {
    console.error('[latch:provider-bridge] emit-active-account', e)
  }
}

injectInpageProvider()

/**
 * After `disconnect()`, Grant Access is sticky-blocked for this origin. A fresh
 * document (reload / new tab) clears that block so a real connect can prompt.
 * Only message when this origin is in the set — avoid waking the SW on every page.
 */
void (async () => {
  try {
    const origin = window.location.origin
    if (!origin || origin === 'null') return
    const bag = await chrome.storage.local.get([DISCONNECTED_ORIGINS_KEY])
    const list = bag[DISCONNECTED_ORIGINS_KEY]
    if (!Array.isArray(list) || !list.includes(origin)) return
    await chrome.runtime.sendMessage({
      type: 'DAPP_PAGE_SESSION_START',
      payload: { origin },
    })
  } catch {
    // Extension context invalidated or storage unavailable — ignore.
  }
})()

window.addEventListener(
  'message',
  (event: MessageEvent) => {
    if (event.source !== window) return
    const data = event.data as ProviderBridgeMessage
    if (!data || data.source !== LATCH_PROVIDER_REQUEST) return
    if (typeof data.messageId !== 'number') return

    void (async () => {
      const res = await handleProviderBridgeRequest(data, {
        pageOrigin: window.location.origin,
        sendMessage: (message) => chrome.runtime.sendMessage(message) as Promise<BgRes<unknown>>,
      })

      window.postMessage(
        {
          source: LATCH_PROVIDER_RESPONSE,
          messageId: data.messageId,
          ok: res?.ok ?? false,
          data: res?.data,
          error: res?.error,
        },
        window.location.origin
      )
    })()
  },
  false
)

chrome.runtime.onMessage.addListener((message: LatchProviderEventMessage) => {
  if (!message || message.type !== 'LATCH_PROVIDER_EVENT') return
  if (message.event !== 'accountChanged' && message.event !== 'networkChanged') return
  postProviderEvent(message)
})

// Reliable path: popup account switches update chrome.storage without focusing the dApp tab.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if (!(ACTIVE_ACCOUNT_ID_KEY in changes) && !(ACCOUNTS_KEY in changes)) return
  void emitActiveAccountFromStorage()
})
