import React, { useEffect, useMemo, useState } from 'react'

import type { NetworkFee } from '@latch/types'

import { friendlyError } from '../../lib/backgroundClient'
import { formatNetworkFeeLine, isUserPaidFeeErrorCode } from '../../lib/networkFee'
import { fiatToCrypto } from '../../lib/sendAmount'
import type { SendDraft, SendFeeEstimate } from '../../types/send'
import { SendSummaryFacts } from './SendSummaryFacts'
import { SendSummaryHeader } from './SendSummaryHeader'
import { SendSummaryHero } from './SendSummaryHero'
import { SendSummarySubmitButton } from './SendSummarySubmitButton'
import { SendTransactionLoadingOverlay } from './SendTransactionLoadingOverlay'

export function SendSummaryScreen({
  draft,
  priceUsd,
  networkLabel,
  sendProgressLabel,
  sendError,
  submitLabel,
  onBack,
  onSend,
  feeEstimateKey = 0,
  onFetchFeeEstimate,
  onReviewedNetworkFee,
}: {
  surface: 'popup' | 'sidepanel'
  draft: SendDraft
  priceUsd: number | null
  networkLabel: string
  sendProgressLabel: string | null
  sendError: string | null
  submitLabel?: string
  onBack: () => void
  onSend: () => void
  feeEstimateKey?: number
  onFetchFeeEstimate: () => Promise<SendFeeEstimate>
  /** Writes the fee the user is reviewing. Ignored when this estimate was superseded. */
  onReviewedNetworkFee: (fee: NetworkFee | null) => void
}) {
  const token = draft.token!
  const isSending = sendProgressLabel != null

  const cryptoAmount = useMemo(() => {
    if (draft.inputMode === 'crypto') return draft.amount
    return fiatToCrypto(draft.amount, priceUsd) ?? '0'
  }, [draft.amount, draft.inputMode, priceUsd])

  const [feeDisplay, setFeeDisplay] = useState('Fast | —')
  const [feeEstimating, setFeeEstimating] = useState(true)
  /** User-paid fee error from the estimate: the send would be refused, so block it here. */
  const [feeError, setFeeError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setFeeEstimating(true)
    setFeeError(null)
    setFeeDisplay('Fast | —')
    onReviewedNetworkFee(null)
    void onFetchFeeEstimate().then((res) => {
      if (cancelled) return
      setFeeEstimating(false)
      if (!res) return
      if (!res.ok) {
        if (isUserPaidFeeErrorCode(res.error.code)) setFeeError(friendlyError(res.error))
        return
      }
      onReviewedNetworkFee(res.data.networkFee ?? null)
      const build = res.data
      const maxFee = formatNetworkFeeLine(build.networkFee)
      if (maxFee) {
        setFeeDisplay(maxFee)
        return
      }
      const label = build.feeLabel ?? 'Fast'
      const xlm = build.estimatedFeeXlm ?? '—'
      const usd = build.estimatedFeeUsd ? ` ($${build.estimatedFeeUsd})` : ''
      setFeeDisplay(`${label} | ${xlm} XLM${usd}`)
    })
    return () => {
      cancelled = true
    }
  }, [onFetchFeeEstimate, onReviewedNetworkFee, feeEstimateKey])

  const errorMessage = sendError ?? feeError

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-4 animate-screenIn">
      <SendSummaryHeader onBack={onBack} disabled={isSending} />
      <div className="h-px w-full shrink-0 bg-stroke" aria-hidden />

      <div className="flex min-h-0 flex-1 flex-col justify-between">
        <div className="flex w-full flex-col items-center gap-3">
          <SendSummaryHero amount={cryptoAmount} symbol={token.code} priceUsd={priceUsd} />
          <SendSummaryFacts
            recipientName={draft.recipientName}
            recipientAddress={draft.recipientAddress}
            networkLabel={networkLabel}
            feeDisplay={feeDisplay}
          />
          {errorMessage && !isSending ? (
            <p className="w-full text-center text-sm tracking-[-0.28px] text-red-300">
              {errorMessage}
            </p>
          ) : null}
        </div>

        <SendSummarySubmitButton
          loading={isSending}
          disabled={feeEstimating || feeError != null}
          onSend={onSend}
          label={submitLabel}
        />
      </div>

      {isSending ? (
        <SendTransactionLoadingOverlay
          amount={cryptoAmount}
          symbol={token.code}
          recipientName={draft.recipientName}
          recipientAddress={draft.recipientAddress}
        />
      ) : null}
    </div>
  )
}
