import React from 'react'
import { Share2 } from 'lucide-react'

import latchLogoUrl from 'url:../../../../assets/home/loading-logo.svg'
import qrIconUrl from 'url:../../../../assets/receive/icon-qr.svg'

import { CopyGlyph, useCopiedFlag } from '../../components/CopyIconButton'
import successIllustrationUrl from 'url:../../../../assets/avatars/success.png'

import { OnboardingPrimaryButton } from '../../onboarding/components/OnboardingCardButtons'

export function MultisigDeploySuccessScreen({
  smartAccountAddress,
  onCopyAddress,
  onShareAddress,
  onOpenReceiveQr,
  onGoToWallet,
}: {
  smartAccountAddress: string
  onCopyAddress: () => void | Promise<void>
  onShareAddress: () => void
  onOpenReceiveQr: () => void
  onGoToWallet: () => void
}) {
  const { copied, markCopied } = useCopiedFlag()

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6">
      <div className="flex w-full shrink-0 flex-col items-center">
        <img src={latchLogoUrl} alt="" className="h-5 w-10 object-contain" aria-hidden />
      </div>

      <div className="flex w-full flex-col items-center gap-6">
        <div className="h-[262px] w-[328px]">
          <img
            src={successIllustrationUrl}
            alt=""
            className="h-full w-full object-contain"
            aria-hidden
          />
        </div>

        <div className="flex w-full flex-col gap-2 text-center">
          <h1 className="text-[22px] font-medium leading-[1.32] tracking-[-0.44px] text-[#fcfcfc]">
            Multisig Wallet Created
          </h1>
          <p className="text-base font-normal leading-[1.36] tracking-[-0.32px] text-[#b3b3b3]">
            Your Multisig wallet is ready to receive funds.
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-between">
        <div className="w-full rounded-[16px] bg-[#121212] p-3">
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold tracking-[-0.16px] text-[#fcfcfc]">
              Wallet Address
            </p>
            <div className="mt-2 rounded-[12px] border border-[#383838] px-3 pt-3">
              <p className="h-[86px] break-all text-base leading-[1.36] tracking-[-0.32px] text-[#b3b3b3]">
                {smartAccountAddress}
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <ActionIconButton
              ariaLabel={copied ? 'Copied' : 'Copy address'}
              onClick={() => {
                if (!smartAccountAddress.trim()) return
                void Promise.resolve(onCopyAddress()).then(() => markCopied())
              }}
            >
              <CopyGlyph copied={copied} className="h-6 w-6" />
            </ActionIconButton>

            <ActionIconButton ariaLabel="Share address" onClick={onShareAddress}>
              <Share2 className="h-6 w-6 text-primary" strokeWidth={2} aria-hidden />
            </ActionIconButton>

            <ActionIconButton ariaLabel="Show QR code" onClick={onOpenReceiveQr}>
              <img src={qrIconUrl} alt="" className="h-6 w-6 object-contain" aria-hidden />
            </ActionIconButton>
          </div>
        </div>

        <div className="mt-6">
          <OnboardingPrimaryButton onClick={onGoToWallet}>Go to Wallet</OnboardingPrimaryButton>
        </div>
      </div>
    </div>
  )
}

function ActionIconButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="flex h-12 w-full items-center justify-center rounded-[14px] bg-[#262626] p-3"
    >
      {children}
    </button>
  )
}
