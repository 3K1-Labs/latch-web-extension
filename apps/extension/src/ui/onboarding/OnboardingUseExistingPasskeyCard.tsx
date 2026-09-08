import emblemUrl from 'url:../../../assets/onboarding/web/latch-logo-emblem.svg'
import biometricFingerprintUrl from 'url:../../../assets/onboarding/web/biometric-fingerprint.svg'

import {
  OnboardingPrimaryButton,
  OnboardingSecondaryButton,
} from './components/OnboardingCardButtons'

export function OnboardingUseExistingPasskeyCard({
  prefetchReady,
  prefetchError,
  actionError,
  busy,
  onAuthenticate,
  onGoBack,
}: {
  prefetchReady: boolean
  prefetchError: string | null
  actionError: string | null
  busy: boolean
  onAuthenticate: () => void
  onGoBack: () => void
}) {
  const errorMessage = actionError ?? prefetchError
  const canAuthenticate = prefetchReady && !busy
  const primaryLabel = !prefetchReady ? 'Preparing…' : busy ? 'Authenticating…' : 'Authenticate'

  return (
    <div className="flex h-[600px] w-[420px] flex-col gap-2 rounded-[24px] bg-[#1c1c1c] p-6 shadow-[-5px_6px_7.7px_rgba(9,9,9,0.3)]">
      <div className="flex min-h-0 flex-1 flex-col gap-8">
        <div className="flex min-h-0 flex-1 flex-col items-center gap-6">
          <div className="flex w-full shrink-0 flex-col items-center gap-2">
            <img
              src={emblemUrl}
              alt=""
              className="h-6 w-[45px] shrink-0"
              width={45}
              height={24}
              draggable={false}
            />

            <div className="flex w-full flex-col items-center gap-[14px] text-center">
              <h1 className="w-full text-[26px] font-medium leading-[1.32] tracking-[-0.52px] text-[#fcfcfc]">
                Use Existing Passkey
              </h1>
              <p className="w-full text-[18px] font-normal leading-[1.36] tracking-[-0.36px] text-[#b3b3b3]">
                Use your passkey to sign in
              </p>
            </div>
          </div>

          <div className="relative flex size-[115px] shrink-0 items-center justify-center rounded-2xl bg-[#201f1e] shadow-[0px_0px_0px_0px_#262626,0px_20px_50px_0px_rgba(0,0,0,0.3)]">
            <img
              src={biometricFingerprintUrl}
              alt=""
              className="size-[76px]"
              width={76}
              height={76}
              draggable={false}
            />
          </div>

          <div className="flex min-h-0 w-full flex-1 flex-col gap-3 overflow-x-clip overflow-y-auto">
            {errorMessage ? (
              <p className="text-center text-[14px] leading-[1.34] tracking-[-0.28px] text-[#b3b3b3]">
                {errorMessage}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex w-full shrink-0 flex-col gap-2">
          <OnboardingPrimaryButton disabled={!canAuthenticate} onClick={onAuthenticate}>
            {primaryLabel}
          </OnboardingPrimaryButton>

          <OnboardingSecondaryButton disabled={busy} onClick={onGoBack}>
            Go Back
          </OnboardingSecondaryButton>
        </div>
      </div>
    </div>
  )
}
