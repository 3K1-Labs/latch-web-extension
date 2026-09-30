import type { SmartAccountTransactionRow } from '@latch/types'

import { getActiveNetwork } from './network/config'

/** Durable activity rows. A failed scan must never write this store. */
export const ACTIVITY_HISTORY_PREFIX = 'latch.activityHistory.'
export const MAX_ACTIVITY_ENTRIES = 200

export function activityHistoryStorageKey(network: string, accountId: string): string {
  return `${ACTIVITY_HISTORY_PREFIX}${network}.${accountId}.v1`
}

export function activityRowKey(row: SmartAccountTransactionRow): string {
  return `${row.transactionHash || row.id}|${row.from}|${row.to}|${row.assetCode}`
}

/**
 * Fresh rows win over stored copies of the same transfer. Oldest past the cap
 * are dropped. Call only with a scan that succeeded.
 */
export function mergeActivityRows(
  fresh: SmartAccountTransactionRow[],
  stored: SmartAccountTransactionRow[]
): SmartAccountTransactionRow[] {
  const seen = new Set<string>()
  return [...fresh, ...stored]
    .filter((row) => {
      const key = activityRowKey(row)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_ACTIVITY_ENTRIES)
}

function isRow(value: unknown): value is SmartAccountTransactionRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<SmartAccountTransactionRow>
  return typeof row.id === 'string' && typeof row.transactionHash === 'string'
}

export async function readActivityHistory(
  accountId: string
): Promise<SmartAccountTransactionRow[]> {
  try {
    const network = await getActiveNetwork()
    const key = activityHistoryStorageKey(network, accountId)
    const r = await chrome.storage.local.get([key])
    const raw = r[key]
    if (!Array.isArray(raw)) return []
    return raw.filter(isRow)
  } catch {
    return []
  }
}

export async function writeActivityHistory(
  accountId: string,
  items: SmartAccountTransactionRow[]
): Promise<void> {
  const network = await getActiveNetwork()
  const key = activityHistoryStorageKey(network, accountId)
  await chrome.storage.local.set({ [key]: items.slice(0, MAX_ACTIVITY_ENTRIES) })
}

export async function clearActivityHistoryForAccount(accountId: string): Promise<void> {
  const network = await getActiveNetwork()
  await chrome.storage.local.remove([activityHistoryStorageKey(network, accountId)])
}

export async function clearAllActivityHistory(): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const keys = Object.keys(all).filter((k) => k.startsWith(ACTIVITY_HISTORY_PREFIX))
  if (keys.length > 0) await chrome.storage.local.remove(keys)
}
