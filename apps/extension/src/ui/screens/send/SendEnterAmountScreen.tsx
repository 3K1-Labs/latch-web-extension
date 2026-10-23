import React, { useMemo, useState } from 'react'

import type { SmartAccountBalanceRow } from '@latch/types'

import {
  cryptoToFiat,
  fiatToCrypto,
  hasValidDecimalPlaces,
  isAmountWithinBalance,
  parsePositiveAmount,
} from '../../lib/sendAmount'
import type { SendDraft, SendInputMode } from '../../types/send'
import { SendAmountDisplay } from './SendAmountDisplay'
import { SendAvailableBalanceRow } from './SendAvailableBalanceRow'
import { SendEnterAmountHeader } from './SendEnterAmountHeader'
import { SendQuickAmountButtons } from './SendQuickAmountButtons'
import { SendRecipientBar } from './SendRecipientBar'

export function SendEnterAmountScreen({
  draft,
  priceUsd,
  onDraftChange,
  onResolveMaxAmount,
  onBack,
  onEditRecipient,
  onNext,
}: {
  surface: 'popup' | 'sidepanel'
  draft: SendDraft
  priceUsd: number | null
  onDraftChange: (patch: Partial<SendDraft>) => void
  /** Balance less the max network fee when this token pays it. Null leaves the amount unchanged. */
  onResolveMaxAmount: (token: SmartAccountBalanceRow) => Promise<string | null>
  onBack: () => void
  onEditRecipient: () => void
  onNext: () => void
}) {
  const token = draft.token!
  const cryptoAmount = useMemo(() => {
    if (draft.inputMode === 'crypto') return draft.amount
    return fiatToCrypto(draft.amount, priceUsd) ?? ''
  }, [draft.amount, draft.inputMode, priceUsd])

  const canContinue = useMemo(() => {
    const n = parsePositiveAmount(cryptoAmount)
    if (n == null) return false
    if (!hasValidDecimalPlaces(cryptoAmount, token.decimals)) return false
    return isAmountWithinBalance(String(n), token.amount)
  }, [cryptoAmount, token.amount, token.decimals])

  const handlePresetUsd = (usd: number) => {
    // Prefer crypto amounts so send can proceed even if the USD price later drops out.
    if (priceUsd != null && priceUsd > 0) {
      const crypto = fiatToCrypto(String(usd), priceUsd)
      if (crypto) {
        onDraftChange({ amount: crypto, inputMode: 'crypto' })
        return
      }
    }
    onDraftChange({ amount: String(usd), inputMode: 'fiat' as SendInputMode })
  }

  const [maxPending, setMaxPending] = useState(false)

  const handleMax = async () => {
    if (maxPending) return
    setMaxPending(true)
    try {
      const amount = await onResolveMaxAmount(token)
      if (amount != null) onDraftChange({ amount, inputMode: 'crypto' })
    } finally {
      setMaxPending(false)
    }
  }

  const toggleMode = () => {
    if (draft.inputMode === 'crypto') {
      if (priceUsd == null || priceUsd <= 0) return
      const fiat = cryptoToFiat(draft.amount || '0', priceUsd)
      onDraftChange({
        inputMode: 'fiat',
        amount: draft.amount && fiat ? fiat : '',
      })
    } else {
      const crypto = fiatToCrypto(draft.amount || '0', priceUsd)
      onDraftChange({
        inputMode: 'crypto',
        amount: draft.amount && crypto ? crypto : '',
      })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 animate-screenIn">
      <SendEnterAmountHeader
        title={`Select ${token.code}`}
        canContinue={canContinue}
        onBack={onBack}
        onNext={onNext}
      />

      <SendRecipientBar
        recipientName={draft.recipientName}
        recipientAddress={draft.recipientAddress}
        onEdit={onEditRecipient}
      />

      <div className="flex min-h-0 flex-1 flex-col justify-between gap-6">
        <div className="flex flex-col items-center gap-4">
          <SendAmountDisplay
            amount={draft.amount}
            inputMode={draft.inputMode}
            symbol={token.code}
            priceUsd={priceUsd}
            onAmountChange={(amount) => onDraftChange({ amount })}
            onToggleMode={toggleMode}
          />
          <SendQuickAmountButtons
            onSelect={handlePresetUsd}
            disabled={priceUsd == null || priceUsd <= 0}
          />
        </div>

        <SendAvailableBalanceRow
          balance={token.amount}
          symbol={token.code}
          disabled={maxPending}
          onMax={() => void handleMax()}
        />
      </div>
    </div>
  )
}
