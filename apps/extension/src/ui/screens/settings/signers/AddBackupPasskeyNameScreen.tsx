import { OnboardingPrimaryButton } from '../../../onboarding/components/OnboardingCardButtons'
import { SettingsScreenHeader } from '../SettingsScreenHeader'

export function AddBackupPasskeyNameScreen({
  passkeyName,
  onPasskeyNameChange,
  onBack,
  onContinue,
}: {
  passkeyName: string
  onPasskeyNameChange: (name: string) => void
  onBack: () => void
  onContinue: () => void
}) {
  const canContinue = passkeyName.trim().length > 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-4">
      <SettingsScreenHeader title="Add Backup Passkey" onBack={onBack} />

      <div className="flex min-h-0 flex-1 flex-col justify-between">
        <div className="flex w-full flex-col gap-2.5">
          <p className="text-sm leading-[1.36] tracking-[-0.28px] text-[#b3b3b3]">
            Name this passkey so you can tell it apart in your password manager. Create it on the
            device or key you want as your backup.
          </p>

          <div className="flex w-full flex-col gap-1">
            <label
              htmlFor="backup-passkey-name"
              className="text-base font-semibold tracking-[-0.16px] text-[#fcfcfc]"
            >
              Passkey Name
            </label>
            <input
              id="backup-passkey-name"
              type="text"
              value={passkeyName}
              onChange={(e) => onPasskeyNameChange(e.target.value)}
              maxLength={32}
              className="h-[52px] w-full rounded-xl border border-[#383838] bg-transparent px-3 text-base tracking-[-0.32px] text-[#fcfcfc] outline-none"
            />
          </div>
        </div>

        <OnboardingPrimaryButton disabled={!canContinue} onClick={onContinue}>
          Continue
        </OnboardingPrimaryButton>
      </div>
    </div>
  )
}
