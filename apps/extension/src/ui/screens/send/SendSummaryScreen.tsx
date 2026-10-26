import React, { useEffect, useMemo, useState } from 'react'

import type { BuildSendTxResponse } from '@latch/types'

import { friendlyError } from '../../lib/backgroundClient'
import { formatNetworkFeeLine, isUserPaidFeeErrorCode } from '../../lib/networkFee'
import { fiatToCrypto } from '../../lib/sendAmount'
import { SEND_SETUP_FAILED_CODE, type FetchSendFeeEstimate, type SendDraft } from '../../types/send'
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
  onReviewedBuild,
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
  onFetchFeeEstimate: FetchSendFeeEstimate
  /** The build the user is reviewing (the one Confirm signs). Null while a new estimate runs. */
  onReviewedBuild: (build: BuildSendTxResponse | null) => void
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
  /** One-time wallet setup failed (e.g. the passkey prompt was dismissed): offer a retry. */
  const [setupFailed, setSetupFailed] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setFeeEstimating(true)
    setFeeError(null)
    setSetupFailed(false)
    setFeeDisplay('Fast | —')
    onReviewedBuild(null)
    void onFetchFeeEstimate({
      onSettingUp: () => {
        if (!cancelled) setFeeDisplay('Setting up your wallet…')
      },
    }).then((res) => {
      if (cancelled) return
      setFeeEstimating(false)
      if (!res) return
      if (!res.ok) {
        if (res.error.code === SEND_SETUP_FAILED_CODE) setSetupFailed(true)
        if (isUserPaidFeeErrorCode(res.error.code) || res.error.code === SEND_SETUP_FAILED_CODE) {
          setFeeError(friendlyError(res.error))
        }
        return
      }
      onReviewedBuild(res.data)
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
  }, [onFetchFeeEstimate, onReviewedBuild, feeEstimateKey, retryKey])

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
          disabled={feeEstimating || (feeError != null && !setupFailed)}
          onSend={setupFailed ? () => setRetryKey((n) => n + 1) : onSend}
          label={setupFailed ? 'Try again' : submitLabel}
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
