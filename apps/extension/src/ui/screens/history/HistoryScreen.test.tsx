/**
 * Screen smoke test template (issue #38):
 * - Put `// @vitest-environment jsdom` at the top of the file.
 * - Render a screen that already takes props (HistoryScreen is the example).
 * - Pass data in; do not fetch, sign, or mount LatchRoot.
 * - Assert visible text with screen.getByText; call cleanup() after each test.
 * - Run: pnpm --filter @latch/extension test
 */
// @vitest-environment jsdom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { HistoryItemVm, HistorySectionVm } from '../../types/history'
import { HistoryScreen } from './HistoryScreen'

afterEach(() => {
  cleanup()
})

function makeItem(overrides: Partial<HistoryItemVm> = {}): HistoryItemVm {
  return {
    id: 'tx-1',
    kind: 'sent',
    asset: 'Sent XLM',
    assetCode: 'XLM',
    status: 'completed',
    timeLabel: '2m ago',
    amountLabel: '-1.00 XLM',
    amountUsd: null,
    transactionHash: 'abc123',
    createdAt: '2026-01-01T00:00:00Z',
    from: 'GFROM',
    to: 'GTO',
    ...overrides,
  }
}

describe('HistoryScreen', () => {
  const onBack = vi.fn()

  it('renders empty state when there are no sections', () => {
    render(
      <HistoryScreen surface="popup" sections={[]} loading={false} error={null} onBack={onBack} />
    )
    expect(screen.getByText('Empty History')).toBeTruthy()
  })

  it('renders loading state', () => {
    render(
      <HistoryScreen surface="popup" sections={[]} loading={true} error={null} onBack={onBack} />
    )
    expect(screen.getByText('Loading transactions…')).toBeTruthy()
  })

  it('renders an error message', () => {
    render(
      <HistoryScreen
        surface="popup"
        sections={[]}
        loading={false}
        error="Could not load history"
        onBack={onBack}
      />
    )
    expect(screen.getByText('Could not load history')).toBeTruthy()
  })

  it('renders a section item asset label', () => {
    const sections: HistorySectionVm[] = [
      {
        title: 'Today',
        items: [makeItem({ asset: 'Sent XLM' })],
      },
    ]
    render(
      <HistoryScreen
        surface="popup"
        sections={sections}
        loading={false}
        error={null}
        onBack={onBack}
      />
    )
    expect(screen.getByText('Sent XLM')).toBeTruthy()
    expect(screen.getByText('Today')).toBeTruthy()
  })
})
