import type { MigrationDiscovery } from '@latch/types'

import { getActiveNetwork, peekCachedActiveNetwork } from '../network/config'

const TTL_MS = 60_000

const cache = new Map<string, { at: number; value: MigrationDiscovery }>()

function networkForCacheKey(): string {
  return peekCachedActiveNetwork() ?? 'mainnet'
}

function key(accountId: string, gAddress: string) {
  return `${networkForCacheKey()}:${accountId}:${gAddress}`
}

export function getCachedDiscovery(
  accountId: string,
  gAddress: string
): MigrationDiscovery | undefined {
  const k = key(accountId, gAddress)
  const row = cache.get(k)
  if (!row) return undefined
  if (Date.now() - row.at > TTL_MS) {
    cache.delete(k)
    return undefined
  }
  return row.value
}

export function setCachedDiscovery(accountId: string, gAddress: string, value: MigrationDiscovery) {
  cache.set(key(accountId, gAddress), { at: Date.now(), value })
}

export function invalidateDiscoveryCacheForAccount(accountId: string) {
  const prefix = `${networkForCacheKey()}:${accountId}:`
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k)
  }
}

/** Drop all discovery cache entries (e.g. on network switch). */
export function clearDiscoveryCache(): void {
  cache.clear()
}

// Warm cache key with async active network when possible.
void getActiveNetwork().catch(() => {})
