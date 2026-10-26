import React from 'react'

import type { BuildSendTxResponse, SmartAccountBalanceRow } from '@latch/types'

import type { FetchSendFeeEstimate, SendDraft, SendResult, SendStep } from '../../types/send'
import { SendEnterAmountScreen } from './SendEnterAmountScreen'
import { SendFailureScreen } from './SendFailureScreen'
import { SendReceiptScreen } from './SendReceiptScreen'
import { SendSelectRecipientScreen } from './SendSelectRecipientScreen'
import { SendSelectTokenScreen } from './SendSelectTokenScreen'
import { SendSuccessScreen } from './SendSuccessScreen'
import { SendSummaryScreen } from './SendSummaryScreen'

export function SendFlow({
  surface,
  step,
  draft,
  result,
  portfolioRows,
  portfolioLoading,
  portfolioError,
  tokenPriceUsd,
  networkLabel,
  network = 'testnet',
  sendProgressLabel,
  sendError,
  createProposalMode,
  onDraftChange,
  onStepChange,
  onBackFromSend,
  feeEstimateKey = 0,
  onFetchFeeEstimate,
  onReviewedBuild,
  onResolveMaxAmount,
  onSubmitSend,
  onContinueHome,
  onTryAgainFromFailure,
}: {
  surface: 'popup' | 'sidepanel'
  step: SendStep
  draft: SendDraft
  result: SendResult | null
  portfolioRows: SmartAccountBalanceRow[]
  portfolioLoading: boolean
  portfolioError: string | null
  tokenPriceUsd: number | null
  networkLabel: string
  network?: import('@latch/types').Network
  sendProgressLabel: string | null
  sendError: string | null
  createProposalMode?: boolean
  onDraftChange: (patch: Partial<SendDraft>) => void
  onStepChange: (step: SendStep) => void
  onBackFromSend: () => void
  /** Bump to make the summary fetch a fresh fee estimate. */
  feeEstimateKey?: number
  onFetchFeeEstimate: FetchSendFeeEstimate
  /** Called only for the summary estimate that is still the live one. */
  onReviewedBuild: (build: BuildSendTxResponse | null) => void
  onResolveMaxAmount: (token: SmartAccountBalanceRow) => Promise<string | null>
  onSubmitSend: () => void
  onContinueHome: () => void
  onTryAgainFromFailure: () => void
}) {
  if (step === 'selectToken') {
    return (
      <SendSelectTokenScreen
        tokens={portfolioRows}
        loading={portfolioLoading}
        error={portfolioError}
        onBack={onBackFromSend}
        onSelectToken={(token) => {
          onDraftChange({ token })
          onStepChange('selectRecipient')
        }}
      />
    )
  }

  if (!draft.token) {
    return null
  }

  if (step === 'selectRecipient') {
    return (
      <SendSelectRecipientScreen
        token={draft.token}
        recipientAddress={draft.recipientAddress}
        onRecipientChange={(address, name) =>
          onDraftChange({ recipientAddress: address, recipientName: name })
        }
        onBack={() => onStepChange('selectToken')}
        onContinue={() => onStepChange('enterAmount')}
      />
    )
  }

  if (step === 'enterAmount') {
    return (
      <SendEnterAmountScreen
        surface={surface}
        draft={draft}
        priceUsd={tokenPriceUsd}
        onDraftChange={onDraftChange}
        onResolveMaxAmount={onResolveMaxAmount}
        onBack={() => onStepChange('selectRecipient')}
        onEditRecipient={() => onStepChange('selectRecipient')}
        onNext={() => onStepChange('summary')}
      />
    )
  }

  if (step === 'summary') {
    return (
      <SendSummaryScreen
        surface={surface}
        draft={draft}
        priceUsd={tokenPriceUsd}
        networkLabel={networkLabel}
        sendProgressLabel={sendProgressLabel}
        sendError={sendError}
        submitLabel={createProposalMode ? 'Create proposal' : 'Send'}
        onBack={() => onStepChange('enterAmount')}
        onSend={onSubmitSend}
        feeEstimateKey={feeEstimateKey}
        onFetchFeeEstimate={onFetchFeeEstimate}
        onReviewedBuild={onReviewedBuild}
      />
    )
  }

  if (step === 'success' && result) {
    return (
      <SendSuccessScreen
        surface={surface}
        draft={draft}
        result={result}
        priceUsd={tokenPriceUsd}
        network={network}
        onContinue={onContinueHome}
        onViewReceipt={() => onStepChange('receipt')}
      />
    )
  }

  if (step === 'failure') {
    return (
      <SendFailureScreen
        surface={surface}
        draft={draft}
        errorDetail={result?.errorMessage}
        priceUsd={tokenPriceUsd}
        onTryAgain={onTryAgainFromFailure}
      />
    )
  }

  if (step === 'receipt' && result) {
    return (
      <SendReceiptScreen
        surface={surface}
        draft={draft}
        result={result}
        priceUsd={tokenPriceUsd}
        onTryAgain={() => onStepChange('summary')}
      />
    )
  }

  return null
}
