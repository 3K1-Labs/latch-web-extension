import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SmartAccountTransactionRow } from '@latch/types'

import {
  MAX_ACTIVITY_ENTRIES,
  clearActivityHistoryForAccount,
  mergeActivityRows,
  readActivityHistory,
  writeActivityHistory,
} from './activityHistory'

vi.mock('./network/config', () => ({
  getActiveNetwork: async () => 'testnet' as const,
}))

function row(
  partial: Partial<SmartAccountTransactionRow> &
    Pick<SmartAccountTransactionRow, 'id' | 'transactionHash' | 'createdAt'>
): SmartAccountTransactionRow {
  return {
    direction: 'sent',
    assetCode: 'XLM',
    amount: '1',
    amountLabel: '-1.00 XLM',
    amountUsd: null,
    status: 'completed',
    kind: 'sent',
    from: 'CFROM',
    to: 'CTO',
    ...partial,
  }
}

describe('mergeActivityRows', () => {
  it('keeps stored rows that the latest scan no longer returns', () => {
    const stored = [row({ id: 'old', transactionHash: 'old', createdAt: '2024-01-01T00:00:00Z' })]
    const fresh = [row({ id: 'new', transactionHash: 'new', createdAt: '2024-06-01T00:00:00Z' })]
    const merged = mergeActivityRows(fresh, stored)
    expect(merged.map((r) => r.transactionHash)).toEqual(['new', 'old'])
  })

  it('prefers the fresh copy and caps at 200', () => {
    const stored = Array.from({ length: MAX_ACTIVITY_ENTRIES }, (_, i) =>
      row({
        id: `s${i}`,
        transactionHash: `s${i}`,
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
      })
    )
    const fresh = [
      row({
        id: 's0',
        transactionHash: 's0',
        createdAt: '2020-01-01T00:00:00.000Z',
        amountLabel: 'fresh',
      }),
    ]
    const merged = mergeActivityRows(fresh, stored)
    expect(merged).toHaveLength(MAX_ACTIVITY_ENTRIES)
    expect(merged.find((r) => r.transactionHash === 's0')?.amountLabel).toBe('fresh')
    expect(merged.some((r) => r.transactionHash === 's0')).toBe(true)
  })
})

describe('activity history storage', () => {
  beforeEach(async () => {
    await clearActivityHistoryForAccount('acc-1')
  })

  it('round-trips rows and does not shrink when the caller skips the write', async () => {
    const kept = [row({ id: 'a', transactionHash: 'a', createdAt: '2024-01-01T00:00:00Z' })]
    await writeActivityHistory('acc-1', kept)
    const first = await readActivityHistory('acc-1')
    expect(first).toHaveLength(1)
    const merged = mergeActivityRows([], first)
    await writeActivityHistory('acc-1', merged)
    expect(await readActivityHistory('acc-1')).toHaveLength(1)
  })
})
