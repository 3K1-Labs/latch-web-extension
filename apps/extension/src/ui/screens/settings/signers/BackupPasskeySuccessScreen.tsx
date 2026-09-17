import importSuccessUrl from 'url:../../../../../assets/onboarding/web/import-success.svg'

import { OnboardingPrimaryButton } from '../../../onboarding/components/OnboardingCardButtons'
import { AddAccountBackHeader } from '../add-account/AddAccountBackHeader'

export function BackupPasskeySuccessScreen({
  passkeyName,
  onBack,
  onViewSigners,
}: {
  passkeyName: string
  onBack: () => void
  onViewSigners: () => void
}) {
  return (
    <div className="flex h-full w-full min-h-0 flex-col gap-4">
      <AddAccountBackHeader onBack={onBack} />

      <div className="flex min-h-0 flex-1 flex-col justify-between">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5">
          <div className="flex w-full flex-col items-center gap-[30px]">
            <img
              src={importSuccessUrl}
              alt=""
              className="h-[208.801px] w-[232.001px] shrink-0"
              width={232}
              height={209}
              draggable={false}
            />
            <div className="flex w-full flex-col items-center gap-3 text-center">
              <h1 className="text-[22px] font-medium leading-[1.32] tracking-[-0.44px] text-[#fcfcfc]">
                Backup Passkey Added!
              </h1>
              <p className="text-[16px] font-normal leading-[1.36] tracking-[-0.32px] text-[#b3b3b3]">
                <span className="font-bold text-[#fcfcfc]">{passkeyName}</span> can now approve
                transactions for this wallet and restore it on a new device.
              </p>
            </div>
          </div>
        </div>

        <OnboardingPrimaryButton onClick={onViewSigners}>View Signers</OnboardingPrimaryButton>
      </div>
    </div>
  )
}
