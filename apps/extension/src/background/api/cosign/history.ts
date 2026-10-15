import type { CosignHistoryTransaction } from '@latch/types'

import { v1FetchForWallet } from '../v1Client'

export async function getWalletHistory(
  wallet: string,
  cAddress: string,
  limit = 50
): Promise<CosignHistoryTransaction[]> {
  const data = await v1FetchForWallet<{ transactions: CosignHistoryTransaction[] }>(
    wallet,
    `/v1/history?c_address=${encodeURIComponent(cAddress)}&limit=${limit}`,
    { method: 'GET' }
  )
  return data.transactions ?? []
}
