import type { BackgroundMessage } from '@latch/types'

import type { OkFn } from '../messageResponse'
import { applyDeveloperMode } from '../api/developerMode'
import { getDeveloperMode } from '../storage'
import { getNetworkConfig } from './config'

/** Returns true if the message type was handled. */
export async function tryHandleNetworkMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
): Promise<boolean> {
  switch (message.type) {
    case 'PING_EXTENSION': {
      sendResponse(ok({ connected: true as const }))
      return true
    }

    case 'GET_ACTIVE_NETWORK': {
      const cfg = await getNetworkConfig()
      sendResponse(ok({ network: cfg.network, networkLabel: cfg.networkLabel }))
      return true
    }

    case 'GET_DEVELOPER_MODE': {
      sendResponse(ok({ enabled: await getDeveloperMode() }))
      return true
    }

    case 'SET_DEVELOPER_MODE': {
      const req = message.payload as { enabled: boolean }
      await applyDeveloperMode(req.enabled === true)
      sendResponse(ok({ enabled: req.enabled === true }))
      return true
    }

    default:
      return false
  }
}
