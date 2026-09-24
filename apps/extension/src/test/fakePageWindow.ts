/**
 * Minimal page window for Vitest (Node) covering postMessage + document injection
 * used by inpage.ts and provider-bridge.ts.
 */

type MessageListener = (event: MessageEvent) => void

export type FakePageWindow = {
  location: { origin: string }
  latch?: unknown
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  postMessage: (data: unknown, targetOrigin?: string) => void
  /** Dispatch a message as if from another window (event.source !== this). */
  dispatchFrom: (source: unknown, data: unknown) => void
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  document: {
    documentElement: { dataset: Record<string, string> }
    head: { prepend: (node: unknown) => void }
    createElement: (tag: string) => { src?: string; async?: boolean }
  }
  /** Recorded postMessage payloads (most recent last). */
  __posted: Array<{ data: unknown; targetOrigin?: string }>
  /** Script nodes prepended by provider-bridge injection. */
  __prependedScripts: Array<{ src?: string; async?: boolean }>
  /** Active `message` listeners (for cleanup assertions). */
  messageListenerCount: () => number
}

function toListener(listener: EventListenerOrEventListenerObject): MessageListener {
  if (typeof listener === 'function') return listener as MessageListener
  return (event) => listener.handleEvent(event)
}

export function createFakePageWindow(origin = 'https://dapp.example'): FakePageWindow {
  const messageListeners = new Set<MessageListener>()
  const posted: Array<{ data: unknown; targetOrigin?: string }> = []
  const prependedScripts: Array<{ src?: string; async?: boolean }> = []
  const dataset: Record<string, string> = {}

  const win: FakePageWindow = {
    location: { origin },
    __posted: posted,
    __prependedScripts: prependedScripts,
    messageListenerCount() {
      return messageListeners.size
    },
    addEventListener(type, listener) {
      if (type !== 'message') return
      messageListeners.add(toListener(listener))
    },
    removeEventListener(type, listener) {
      if (type !== 'message') return
      messageListeners.delete(toListener(listener))
    },
    postMessage(data, targetOrigin) {
      posted.push({ data, targetOrigin })
      const event = { source: win, data } as MessageEvent
      for (const listener of [...messageListeners]) {
        listener(event)
      }
    },
    dispatchFrom(source, data) {
      const event = { source, data } as MessageEvent
      for (const listener of [...messageListeners]) {
        listener(event)
      }
    },
    // Resolve timers at call time so vi.useFakeTimers() still works.
    setTimeout(...args: Parameters<typeof setTimeout>) {
      return globalThis.setTimeout(...args)
    },
    clearTimeout(...args: Parameters<typeof clearTimeout>) {
      return globalThis.clearTimeout(...args)
    },
    document: {
      documentElement: { dataset },
      head: {
        prepend(node) {
          prependedScripts.push(node as { src?: string; async?: boolean })
        },
      },
      createElement(tag) {
        if (tag !== 'script') return {}
        return { src: undefined, async: undefined }
      },
    },
  }

  return win
}

export function installFakePageWindow(origin?: string): FakePageWindow {
  const win = createFakePageWindow(origin)
  ;(globalThis as unknown as { window: FakePageWindow }).window = win
  ;(globalThis as unknown as { document: FakePageWindow['document'] }).document = win.document
  return win
}
