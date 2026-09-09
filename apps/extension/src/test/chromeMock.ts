type StorageArea = {
  get: (keys?: string[] | Record<string, any>) => Promise<Record<string, any>>
  set: (items: Record<string, any>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
}

export function createChromeMock() {
  const store = new Map<string, any>()
  const onMessageListeners: Array<
    (message: any, sender: any, sendResponse: (res: any) => void) => void
  > = []

  const local: StorageArea = {
    async get(keys) {
      if (!keys) {
        return Object.fromEntries(store.entries())
      }

      if (Array.isArray(keys)) {
        const out: Record<string, any> = {}
        for (const k of keys) out[k] = store.get(k)
        return out
      }

      const out: Record<string, any> = {}
      for (const [k, defaultValue] of Object.entries(keys)) {
        out[k] = store.has(k) ? store.get(k) : defaultValue
      }
      return out
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v)
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) store.delete(k)
    },
  }

  return {
    storage: {
      local,
      onChanged: {
        addListener() {},
      },
    },
    runtime: {
      getURL(path: string) {
        return `chrome-extension://test/${path}`
      },
      async sendMessage(message: any) {
        const listener = onMessageListeners[onMessageListeners.length - 1]
        if (!listener) throw new Error('No chrome.runtime.onMessage listener registered')
        return await new Promise((resolve) => listener(message, {}, resolve))
      },
      onMessage: {
        addListener(cb: any) {
          onMessageListeners.push(cb)
        },
      },
      onInstalled: {
        addListener() {},
      },
      onStartup: {
        addListener() {},
      },
    },
    action: {
      async setPopup() {},
      async openPopup() {},
      onClicked: {
        addListener() {},
      },
    },
    tabs: {
      async query() {
        return []
      },
      async create() {
        return { id: 1 }
      },
      async update() {},
    },
    windows: {
      async getCurrent() {
        return { id: 1 }
      },
      async getLastFocused() {
        return { id: 1 }
      },
      async update() {},
    },
    sidePanel: {
      async open() {},
      async close() {},
      async setOptions() {},
      async setPanelBehavior() {},
    },
  }
}
