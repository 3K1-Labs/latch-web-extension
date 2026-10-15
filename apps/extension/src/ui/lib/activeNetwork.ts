import type { Network } from '@latch/types'
import { Networks } from '@stellar/stellar-sdk'

import { sendToBackground } from './backgroundClient'

export type ActiveNetworkInfo = {
  network: Network
  networkLabel: string
}

export function networkPassphraseFor(network: Network): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
}

export function stellarExpertNetworkPath(network: Network): 'testnet' | 'public' {
  return network === 'mainnet' ? 'public' : 'testnet'
}

export function networkLabelFor(network: Network): string {
  return network === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet'
}

export async function fetchActiveNetwork(): Promise<ActiveNetworkInfo> {
  const res = await sendToBackground<undefined, ActiveNetworkInfo>({
    type: 'GET_ACTIVE_NETWORK',
    payload: undefined,
  })
  if (res.ok && res.data?.network) {
    return {
      network: res.data.network,
      networkLabel: res.data.networkLabel ?? networkLabelFor(res.data.network),
    }
  }
  return { network: 'mainnet', networkLabel: networkLabelFor('mainnet') }
}
