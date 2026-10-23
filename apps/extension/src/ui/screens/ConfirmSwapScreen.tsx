import React, { useEffect, useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'

import type { SwapDraft, SwapQuoteVm, SwapTokenVm } from '../swap/swapVm'
import { formatQuoteRemainingMs, truncateAddress } from '../swap/swapVm'
import { ExchangeBalanceToggle } from './swap/components/ExchangeBalanceToggle'
import { ConfirmSwapAssetCard } from './swap/components/confirm/ConfirmSwapAssetCard'
import { ConfirmSwapDetailRow } from './swap/components/confirm/ConfirmSwapDetailRow'
import { ConfirmSwapFooter } from './swap/components/confirm/ConfirmSwapFooter'
import { ConfirmSwapHeader } from './swap/components/confirm/ConfirmSwapHeader'
import { ConfirmSwapSection } from './swap/components/confirm/ConfirmSwapSection'

function formatReceiveAmountLine(amount: number, symbol: string) {
  const trimmed = amount
    .toFixed(8)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '')
  return `+${trimmed} ${symbol}`
}

export function ConfirmSwapScreen({
  surface,
  draft,
  quote,
  resolveSwapToken,
  receiveAddress,
  busy = false,
  confirmDisabled = false,
  feeError = null,
  onBackOrCancel,
  onConfirm,
}: {
  surface: 'popup' | 'sidepanel'
  draft: SwapDraft
  quote: SwapQuoteVm
  resolveSwapToken: (id: string) => SwapTokenVm | undefined
  receiveAddress?: string
  busy?: boolean
  confirmDisabled?: boolean
  feeError?: string | null
  onBackOrCancel: () => void
  onConfirm: () => void
}) {
  const [mevProtection, setMevProtection] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const quoteRemainingMs = quote.quotePayload.expiresAtMs - nowMs
  const quoteExpired = quoteRemainingMs <= 0
  const quoteExpiryLine = quoteExpired
    ? 'Quote expired — refreshing price'
    : `Quote refreshes in ${formatQuoteRemainingMs(quoteRemainingMs)}`

  const payToken = useMemo(
    () => resolveSwapToken(draft.payTokenId) ?? quote.quotePayload.assetIn,
    [draft.payTokenId, quote.quotePayload.assetIn, resolveSwapToken]
  )
  const receiveToken = useMemo(
    () => resolveSwapToken(draft.receiveTokenId) ?? quote.quotePayload.assetOut,
    [draft.receiveTokenId, quote.quotePayload.assetOut, resolveSwapToken]
  )

  const accountAddr = receiveAddress?.trim() || ''
  const shortAccountAddr = accountAddr ? truncateAddress(accountAddr, 6, 4) : '—'

  const spendLine = `-${draft.payAmount || '0'} ${payToken.symbol}`
  const spendUsd = quote.receiveUsdApproxLine ? quote.receiveUsdApprox.replace('≈ ', '≈') : '≈--'
  const receiveLine = formatReceiveAmountLine(quote.receiveAmount, receiveToken.symbol)
  const receiveUsd = quote.receiveUsdApproxLine.replace('≈ ', '≈') || quote.receiveUsdApprox

  return (
    <div
      className={[
        'flex min-h-0 flex-1 flex-col overflow-y-auto',
        surface === 'sidepanel' ? 'pt-2' : 'pt-3',
      ].join(' ')}
    >
      <ConfirmSwapHeader onBack={onBackOrCancel} />

      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-5">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <ConfirmSwapSection label="From">
              <ConfirmSwapAssetCard
                token={payToken}
                title={`${payToken.name}`}
                subtitle={accountAddr ? `Account: ${shortAccountAddr}` : undefined}
                trailing={
                  <button
                    type="button"
                    onClick={onBackOrCancel}
                    disabled={busy}
                    className="text-[#b3b3b3] transition-colors hover:text-[#fcfcfc] disabled:opacity-50"
                    aria-label="Edit"
                  >
                    <Pencil className="size-5" strokeWidth={2} />
                  </button>
                }
              />
            </ConfirmSwapSection>

            <ConfirmSwapSection label="Spend">
              <ConfirmSwapAssetCard token={payToken} title={spendLine} subtitle={spendUsd} />
            </ConfirmSwapSection>

            <ConfirmSwapSection label="Receive (Estimated)">
              <ConfirmSwapAssetCard
                token={receiveToken}
                title={receiveLine}
                subtitle={receiveUsd}
                trailing={null}
              />
            </ConfirmSwapSection>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-xs tracking-[-0.24px] text-[#b3b3b3]">MEV Protection</span>
              <ExchangeBalanceToggle checked={mevProtection} onChange={setMevProtection} />
            </div>

            <ConfirmSwapDetailRow
              label="Network Fee"
              value={quote.networkFeeLine.replace('~ ', '')}
            />

            <ConfirmSwapDetailRow label="Min. Received" value={quote.minReceivedLine.trim()} />

            <ConfirmSwapDetailRow label="Quote" value={quoteExpiryLine} />

            <div className="flex items-center justify-between">
              <span className="text-xs tracking-[-0.24px] text-[#b3b3b3]">Provider</span>
              <span className="text-xs font-medium tracking-[-0.12px] text-[#fcfcfc]">
                {quote.provider}
              </span>
            </div>

            <ConfirmSwapDetailRow label="Receive Address" value={shortAccountAddr} />
          </div>
        </div>

        {feeError ? (
          <p className="text-center text-sm tracking-[-0.28px] text-red-300">{feeError}</p>
        ) : null}

        <ConfirmSwapFooter
          busy={busy}
          confirmDisabled={confirmDisabled}
          onCancel={onBackOrCancel}
          onConfirm={onConfirm}
        />
      </div>
    </div>
  )
}
