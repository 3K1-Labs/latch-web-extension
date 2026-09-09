import React, { useState, type ClipboardEvent } from 'react'

import {
  OnboardingPrimaryButton,
  OnboardingSecondaryButton,
} from '../../onboarding/components/OnboardingCardButtons'
import { OnboardingSmallEmblem } from '../../onboarding/components/OnboardingSmallEmblem'
import { SettingsScreenHeader } from '../settings/SettingsScreenHeader'

export function AddExistingMultisigScreen({
  address,
  label,
  error,
  busy,
  onAddressChange,
  onLabelChange,
  onBack,
  onSubmit,
}: {
  address: string
  label: string
  error: string | null
  busy: boolean
  onAddressChange: (next: string) => void
  onLabelChange: (next: string) => void
  onBack: () => void
  onSubmit: () => void
}) {
  const [touched, setTouched] = useState(false)
  const trimmed = address.trim()
  const looksLikeContract = /^C[A-Z2-7]{55}$/.test(trimmed)
  const showFormatHint = touched && trimmed.length > 0 && !looksLikeContract
  const canSubmit = looksLikeContract && !busy

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6">
      <SettingsScreenHeader title="Add MultiSig" onBack={onBack} />

      <div className="flex w-full shrink-0 flex-col items-center gap-2">
        <OnboardingSmallEmblem />
        <div className="flex w-full flex-col gap-2 text-center">
          <h1 className="text-[22px] font-medium leading-[1.32] tracking-[-0.44px] text-[#fcfcfc]">
            Add existing MultiSig
          </h1>
          <p className="text-[18px] font-normal leading-[1.36] tracking-[-0.36px] text-[#b3b3b3]">
            Paste the address of a MultiSig wallet you already co-own
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-between gap-4 overflow-y-auto">
        <div className="flex w-full flex-col gap-4">
          <label className="flex w-full flex-col gap-2">
            <span className="text-sm font-semibold uppercase tracking-wide text-[#b3b3b3]">
              Wallet address
            </span>
            <input
              value={address}
              inputMode="text"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => onAddressChange(e.target.value.trim())}
              onBlur={() => setTouched(true)}
              onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
                const text = e.clipboardData.getData('text/plain').trim()
                if (!text) return
                e.preventDefault()
                onAddressChange(text)
              }}
              placeholder="C…"
              className="h-[52px] w-full rounded-xl border border-[#383838] bg-transparent px-3 font-mono text-sm text-[#fcfcfc] outline-none placeholder:font-sans placeholder:text-base placeholder:text-[#b3b3b3] focus:border-[#f0a300] disabled:opacity-60"
            />
          </label>

          <label className="flex w-full flex-col gap-2">
            <span className="text-sm font-semibold uppercase tracking-wide text-[#b3b3b3]">
              Name (optional)
            </span>
            <input
              value={label}
              disabled={busy}
              onChange={(e) => onLabelChange(e.target.value)}
              placeholder="Multisig wallet"
              className="h-[52px] w-full rounded-xl border border-[#383838] bg-transparent px-3 text-base text-[#fcfcfc] outline-none placeholder:text-[#b3b3b3] focus:border-[#f0a300] disabled:opacity-60"
            />
          </label>

          {showFormatHint ? (
            <p className="text-sm text-[#b3b3b3]">
              A MultiSig wallet address starts with C and is 56 characters long.
            </p>
          ) : null}
          {error ? <p className="text-sm text-[#ea471e]">{error}</p> : null}

          <p className="rounded-[14px] bg-[#2a2928] p-3 text-sm leading-[1.34] tracking-[-0.28px] text-[#b3b3b3]">
            We check that this device is one of the wallet&apos;s signers before adding it. Adding a
            wallet does not grant you any new permissions.
          </p>
        </div>

        {canSubmit ? (
          <OnboardingPrimaryButton onClick={onSubmit}>Continue</OnboardingPrimaryButton>
        ) : (
          <OnboardingSecondaryButton disabled>
            {busy ? 'Checking…' : 'Continue'}
          </OnboardingSecondaryButton>
        )}
      </div>
    </div>
  )
}
