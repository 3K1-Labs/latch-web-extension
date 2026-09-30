import React, { useMemo, useState } from 'react'

import { SectionCard } from '../../components/SectionCard'
import type { HistoryItemVm, HistorySectionVm } from '../../types/history'
import { HistoryEmptyState } from './HistoryEmptyState'
import { HistoryFilterChips, type HistoryFilter } from './HistoryFilterChips'
import { HistoryHeader } from './HistoryHeader'
import { HistorySearchRow } from './HistorySearchRow'
import { HistorySectionList } from './HistorySectionList'
import { MAIN_BOTTOM_NAV_CLEARANCE_PX } from '../home/components/MainBottomNav'

export type HistorySurface = 'popup' | 'sidepanel'

export function HistoryScreen({
  surface: _surface,
  sections,
  loading,
  error,
  onBack,
  onSelectItem,
  onRefresh,
}: {
  surface: HistorySurface
  sections: HistorySectionVm[]
  loading?: boolean
  error?: string | null
  onBack: () => void
  onSelectItem?: (item: HistoryItemVm) => void
  onRefresh?: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<HistoryFilter>('all')

  const view = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sections
      .map((s) => {
        const items = s.items.filter((it) => {
          const okFilter = filter === 'all' ? true : it.kind === filter
          const okQuery =
            q.length === 0
              ? true
              : it.asset.toLowerCase().includes(q) ||
                it.assetCode.toLowerCase().includes(q) ||
                it.transactionHash.toLowerCase().includes(q)
          return okFilter && okQuery
        })
        return { ...s, items }
      })
      .filter((s) => s.items.length > 0)
  }, [sections, query, filter])

  const isEmpty = !loading && !error && view.length === 0

  return (
    <div
      className="flex min-h-0 flex-1 flex-col animate-screenIn"
      style={{ paddingBottom: MAIN_BOTTOM_NAV_CLEARANCE_PX }}
    >
      <HistoryHeader onBack={onBack} />
      <div className="mt-5">
        <HistorySearchRow value={query} onChange={setQuery} onRefreshClick={onRefresh} />
      </div>
      <div className="mt-4">
        <HistoryFilterChips active={filter} onChange={setFilter} />
      </div>

      <div className="mt-5 min-h-0 flex-1 overflow-auto pb-1 pr-1">
        {error && view.length > 0 ? (
          <SectionCard className="mb-3 text-center text-sm font-bold text-red-300">
            {error}
          </SectionCard>
        ) : null}
        {loading && view.length === 0 ? (
          <SectionCard className="text-center text-sm font-bold text-muted">
            Loading transactions…
          </SectionCard>
        ) : error && view.length === 0 ? (
          <SectionCard className="text-center text-sm font-bold text-red-300">{error}</SectionCard>
        ) : isEmpty ? (
          <HistoryEmptyState />
        ) : view.length === 0 ? (
          <SectionCard className="text-center text-sm font-bold text-muted">
            No transactions match your filters.
          </SectionCard>
        ) : (
          <HistorySectionList
            sections={view}
            onSelectItem={(id) => {
              const item = view.flatMap((s) => s.items).find((x) => x.id === id)
              if (item) onSelectItem?.(item)
            }}
          />
        )}
      </div>
    </div>
  )
}
