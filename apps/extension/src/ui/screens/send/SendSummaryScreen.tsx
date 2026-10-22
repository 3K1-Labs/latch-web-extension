import React, { useEffect, useMemo, useState } from 'react'

import type { BuildSendTxResponse } from '@latch/types'

import { formatNetworkFeeLine } from '../../lib/networkFee'
import { fiatToCrypto } from '../../lib/sendAmount'
import type { SendDraft } from '../../types/send'
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
  onFetchFeeEstimate,
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
  onFetchFeeEstimate: () => Promise<BuildSendTxResponse | null>
}) {
  const token = draft.token!
  const isSending = sendProgressLabel != null

  const cryptoAmount = useMemo(() => {
    if (draft.inputMode === 'crypto') return draft.amount
    return fiatToCrypto(draft.amount, priceUsd) ?? '0'
  }, [draft.amount, draft.inputMode, priceUsd])

  const [feeDisplay, setFeeDisplay] = useState('Fast | —')

  useEffect(() => {
    let cancelled = false
    void onFetchFeeEstimate().then((res) => {
      if (cancelled || !res) return
      const maxFee = formatNetworkFeeLine(res.networkFee)
      if (maxFee) {
        setFeeDisplay(maxFee)
        return
      }
      const label = res.feeLabel ?? 'Fast'
      const xlm = res.estimatedFeeXlm ?? '—'
      const usd = res.estimatedFeeUsd ? ` ($${res.estimatedFeeUsd})` : ''
      setFeeDisplay(`${label} | ${xlm} XLM${usd}`)
    })
    return () => {
      cancelled = true
    }
  }, [onFetchFeeEstimate])

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
          {sendError && !isSending ? (
            <p className="w-full text-center text-sm tracking-[-0.28px] text-red-300">
              {sendError}
            </p>
          ) : null}
        </div>

        <SendSummarySubmitButton loading={isSending} onSend={onSend} label={submitLabel} />
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
