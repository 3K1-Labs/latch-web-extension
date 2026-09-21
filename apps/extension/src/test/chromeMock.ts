type StorageChangeListener = (
  changes: { [key: string]: { oldValue?: any; newValue?: any } },
  areaName: string
) => void

type StorageArea = {
  get: (
    keys?: string | string[] | Record<string, any>,
    callback?: (items: Record<string, any>) => void
  ) => Promise<Record<string, any>> | void
  set: (items: Record<string, any>, callback?: () => void) => Promise<void> | void
  remove: (keys: string | string[], callback?: () => void) => Promise<void> | void
}

function createStorageArea(
  store: Map<string, any>,
  areaName: string,
  onChangedListeners: StorageChangeListener[]
): StorageArea {
  return {
    get(keys, callback) {
      const run = async () => {
        if (keys == null) {
          return Object.fromEntries(store.entries())
        }

        if (typeof keys === 'string') {
          return { [keys]: store.get(keys) }
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
      }

      if (callback) {
        void run().then(callback)
        return
      }
      return run()
    },
    set(items, callback) {
      const run = async () => {
        const changes: { [key: string]: { oldValue?: any; newValue?: any } } = {}
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: store.get(k), newValue: v }
          store.set(k, v)
        }
        for (const listener of onChangedListeners) listener(changes, areaName)
      }
      if (callback) {
        void run().then(() => callback())
        return
      }
      return run()
    },
    remove(keys, callback) {
      const run = async () => {
        const list = Array.isArray(keys) ? keys : [keys]
        const changes: { [key: string]: { oldValue?: any; newValue?: any } } = {}
        for (const k of list) {
          if (store.has(k)) {
            changes[k] = { oldValue: store.get(k), newValue: undefined }
            store.delete(k)
          }
        }
        if (Object.keys(changes).length > 0) {
          for (const listener of onChangedListeners) listener(changes, areaName)
        }
      }
      if (callback) {
        void run().then(() => callback())
        return
      }
      return run()
    },
  }
}

export function createChromeMock() {
  const localStore = new Map<string, any>()
  const sessionStore = new Map<string, any>()
  const onMessageListeners: Array<
    (message: any, sender: any, sendResponse: (res: any) => void) => void
  > = []
  const onChangedListeners: StorageChangeListener[] = []
  let lastError: { message: string } | undefined
  let currentWindow: { id?: number; type?: string } = { id: 1, type: 'normal' }

  const local = createStorageArea(localStore, 'local', onChangedListeners)
  const session = createStorageArea(sessionStore, 'session', onChangedListeners)

  return {
    storage: {
      local,
      session,
      onChanged: {
        addListener(cb: StorageChangeListener) {
          onChangedListeners.push(cb)
        },
        removeListener(cb: StorageChangeListener) {
          const idx = onChangedListeners.indexOf(cb)
          if (idx >= 0) onChangedListeners.splice(idx, 1)
        },
      },
    },
    runtime: {
      id: 'test',
      lastError: undefined as { message: string } | undefined,
      getURL(path: string) {
        return `chrome-extension://test/${path}`
      },
      async sendMessage(message: any) {
        const listener = onMessageListeners[onMessageListeners.length - 1]
        if (!listener) throw new Error('No chrome.runtime.onMessage listener registered')
        // Default: extension UI sender (popup/sidepanel) so background integration
        // tests keep the full message protocol.
        const extensionSender = {
          id: 'test',
          origin: 'chrome-extension://test',
          url: 'chrome-extension://test/popup.html',
        }
        return await new Promise((resolve) => listener(message, extensionSender, resolve))
      },
      onMessage: {
        addListener(cb: any) {
          onMessageListeners.push(cb)
        },
        removeListener(cb: any) {
          const idx = onMessageListeners.indexOf(cb)
          if (idx >= 0) onMessageListeners.splice(idx, 1)
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
        return currentWindow
      },
      async getLastFocused() {
        return currentWindow
      },
      async update() {},
      async remove() {},
      create(
        _opts: Record<string, unknown>,
        callback?: (win?: { id?: number; type?: string }) => void
      ) {
        const win = { id: 99, type: 'popup' as const }
        currentWindow = win
        const runtimeApi = (globalThis as any).chrome?.runtime
        if (runtimeApi) runtimeApi.lastError = lastError
        if (callback) callback(lastError ? undefined : win)
        return Promise.resolve(lastError ? undefined : win)
      },
      onRemoved: {
        addListener() {},
        removeListener() {},
      },
    },
    sidePanel: {
      async open() {},
      async close() {},
      async setOptions() {},
      async setPanelBehavior() {},
    },
    /** Test helpers */
    __setCurrentWindow(win: { id?: number; type?: string }) {
      currentWindow = win
    },
    __setLastError(err: { message: string } | undefined) {
      lastError = err
    },
    __sessionStore: sessionStore,
  }
}
