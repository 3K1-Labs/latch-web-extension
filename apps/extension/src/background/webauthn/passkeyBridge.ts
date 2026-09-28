/**
 * Background-owned passkey-bridge waiter. Survives action-popup destruction when
 * the ceremony window takes focus.
 */

export const LATCH_PASSKEY_BRIDGE_RESULT = 'LATCH_PASSKEY_BRIDGE_RESULT' as const

const REQ_PREFIX = 'latchPasskeyBridgeReq:'
const RESULT_PREFIX = 'latchPasskeyBridgeResult:'

export function passkeyBridgeStorageKey(ticket: string): string {
  return `${REQ_PREFIX}${ticket}`
}

export function passkeyBridgeResultStorageKey(ticket: string): string {
  return `${RESULT_PREFIX}${ticket}`
}

export type PasskeyBridgeStoredPayload = {
  mode: 'registration' | 'authentication'
  optionsJSON: unknown
  createdAt: number
}

export type PasskeyBridgeStoredResult = {
  ok: boolean
  response?: unknown
  error?: string
  createdAt: number
}

function settleFromResult(
  result: PasskeyBridgeStoredResult,
  resolve: (value: unknown) => void,
  reject: (reason?: unknown) => void
) {
  if (result.ok && result.response !== undefined) resolve(result.response)
  else reject(new Error(result.error ?? 'Passkey was cancelled or failed.'))
}

export async function runPasskeyBridgeAndWait(args: {
  mode: 'registration' | 'authentication'
  optionsJSON: unknown
  timeoutMs?: number
}): Promise<unknown> {
  if (typeof chrome === 'undefined' || !chrome.windows?.create || !chrome.storage?.session) {
    throw new Error('Passkey bridge requires Chrome extension APIs.')
  }

  const ticket = crypto.randomUUID()
  const key = passkeyBridgeStorageKey(ticket)
  const resultKey = passkeyBridgeResultStorageKey(ticket)

  try {
    JSON.stringify(args.optionsJSON)
  } catch {
    throw new Error('Passkey options are not serializable for the bridge window.')
  }

  const payload: PasskeyBridgeStoredPayload = {
    mode: args.mode,
    optionsJSON: args.optionsJSON,
    createdAt: Date.now(),
  }

  const url = chrome.runtime.getURL(`tabs/passkey-bridge.html#${encodeURIComponent(ticket)}`)
  const timeoutMs = args.timeoutMs ?? 120_000

  return await new Promise((resolve, reject) => {
    let settled = false
    let bridgeWindowId: number | undefined

    // The bridge is ceremony-only; it must not outlive the passkey prompt.
    const closeBridgeWindow = () => {
      if (bridgeWindowId === undefined) return
      const id = bridgeWindowId
      bridgeWindowId = undefined
      void Promise.resolve(chrome.windows.remove(id)).catch(() => {})
    }

    const cleanup = () => {
      chrome.runtime.onMessage.removeListener(onMsg)
      chrome.storage.onChanged.removeListener(onStorage)
      void chrome.storage.session.remove([key, resultKey]).catch(() => {})
      closeBridgeWindow()
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(to)
      cleanup()
      fn()
    }

    const to = setTimeout(() => {
      finish(() => reject(new Error('Passkey prompt timed out.')))
    }, timeoutMs)

    const onMsg = (message: unknown) => {
      const m = message as {
        type?: string
        ticket?: string
        ok?: boolean
        response?: unknown
        error?: string
      }
      if (m?.type !== LATCH_PASSKEY_BRIDGE_RESULT || m.ticket !== ticket) {
        return
      }
      finish(() => {
        if (m.ok && m.response !== undefined) resolve(m.response)
        else reject(new Error(m.error ?? 'Passkey was cancelled or failed.'))
      })
    }

    const onStorage = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'session') return
      const change = changes[resultKey]
      if (!change || change.newValue == null) return
      const result = change.newValue as PasskeyBridgeStoredResult
      finish(() => settleFromResult(result, resolve, reject))
    }

    chrome.runtime.onMessage.addListener(onMsg)
    chrome.storage.onChanged.addListener(onStorage)

    void chrome.storage.session.get(resultKey).then((bag) => {
      const existing = bag[resultKey] as PasskeyBridgeStoredResult | undefined
      if (!existing || settled) return
      finish(() => settleFromResult(existing, resolve, reject))
    })

    chrome.storage.session.set({ [key]: payload }, () => {
      const last = chrome.runtime.lastError
      if (last) {
        finish(() => reject(new Error(last.message)))
        return
      }
      // Omit left/top — Wayland often rejects explicit bounds.
      chrome.windows.create(
        {
          url,
          type: 'popup',
          width: 440,
          height: 580,
          focused: true,
        },
        (win) => {
          const wErr = chrome.runtime.lastError
          if (!wErr && win?.id !== undefined) {
            bridgeWindowId = win.id
            if (settled) closeBridgeWindow()
          }
          if (wErr) {
            finish(() =>
              reject(
                new Error(
                  wErr.message ||
                    'Failed to open the passkey window. Try again, or use the side panel.'
                )
              )
            )
          }
        }
      )
    })
  })
}
