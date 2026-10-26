import { isContractInstanceDeployed } from '@latch/stellar'

import type {
  CreateOrConnectDelegatedRequest,
  CreateOrConnectDelegatedResponse,
  CreateOrConnectPasskeyRequest,
  CreateOrConnectPasskeyResponse,
  DelegatedSmartAccountStatusResponse,
} from '@latch/types'

import { getActiveNetwork, sorobanRpcUrlFor } from '../network/config'
import { latchFetch } from './client'
import { withActiveNetwork } from './withActiveNetwork'

export async function getDelegatedSmartAccountStatus(
  gAddress: string
): Promise<DelegatedSmartAccountStatusResponse> {
  const q = encodeURIComponent(gAddress)
  const network = await getActiveNetwork()
  return await latchFetch<DelegatedSmartAccountStatusResponse>(
    `/api/smart-account/delegated?gAddress=${q}&network=${encodeURIComponent(network)}`,
    { method: 'GET' }
  )
}

export async function createOrConnectDelegated(
  req: CreateOrConnectDelegatedRequest
): Promise<CreateOrConnectDelegatedResponse> {
  return await latchFetch<CreateOrConnectDelegatedResponse>('/api/smart-account/delegated', {
    method: 'POST',
    body: JSON.stringify(await withActiveNetwork(req)),
  })
}

/** GET predict/deploy flow: returns smart account address; POST only if not yet deployed. */
export async function ensureDelegatedSmartAccountDeployed(
  gAddress: string
): Promise<CreateOrConnectDelegatedResponse> {
  const status = await getDelegatedSmartAccountStatus(gAddress)
  if (status.deployed) {
    return { smartAccountAddress: status.smartAccountAddress, alreadyDeployed: true }
  }
  return await createOrConnectDelegated({ gAddress })
}

export async function createOrConnectPasskey(
  req: CreateOrConnectPasskeyRequest
): Promise<CreateOrConnectPasskeyResponse> {
  return await latchFetch<CreateOrConnectPasskeyResponse>('/api/smart-account/webauthn', {
    method: 'POST',
    body: JSON.stringify(
      await withActiveNetwork({
        keyDataHex: req.keyDataHex,
        credentialId: req.credentialId,
      })
    ),
  })
}

/**
 * Deploy the passkey smart account on the active network if missing.
 * Only for explicit create/connect — never call from the send path.
 * When `smartAccountAddress` is already known, do not POST create-or-connect:
 * a new factory returns a different C-address and would displace the funded wallet.
 */
export async function ensurePasskeySmartAccountDeployed(req: {
  keyDataHex: string
  credentialId: string
  smartAccountAddress?: string
}): Promise<CreateOrConnectPasskeyResponse> {
  const keyDataHex = req.keyDataHex.trim()
  const credentialId = req.credentialId.trim()
  if (!keyDataHex) throw new Error('Missing passkey key data for smart account deploy.')
  if (!credentialId) throw new Error('Missing passkey credential id for smart account deploy.')

  const hinted = req.smartAccountAddress?.trim()
  if (hinted) {
    try {
      const network = await getActiveNetwork()
      const rpcUrl = sorobanRpcUrlFor(network)
      const deployed = await isContractInstanceDeployed(rpcUrl, hinted, AbortSignal.timeout(8_000))
      if (deployed) {
        return { smartAccountAddress: hinted, alreadyDeployed: true }
      }
    } catch {
      // fall through — still do not create-or-connect a different address
    }
    // Keep the known address. create-or-connect with a new factory would return another C-address.
    return { smartAccountAddress: hinted, alreadyDeployed: false }
  }

  return await createOrConnectPasskey({ keyDataHex, credentialId })
}
