import { Plus } from 'lucide-react'

import type { AccountSignerRecord } from '@latch/types'

import { LatchLoadingOverlay } from '../../../components/LatchLoadingOverlay'
import { OnboardingPrimaryButton } from '../../../onboarding/components/OnboardingCardButtons'
import { SettingsScreenHeader } from '../SettingsScreenHeader'
import { AccountSignerRow } from './AccountSignerRow'

export function AccountSignersScreen({
  signers,
  loading,
  busyLabel,
  error,
  onReverify,
  onBack,
  onAddBackupPasskey,
  onFinishSetup,
  onRemoveSigner,
}: {
  signers: AccountSignerRecord[]
  loading: boolean
  busyLabel: string | null
  error: string | null
  onReverify?: () => void
  onBack: () => void
  onAddBackupPasskey: () => void
  onFinishSetup: (credentialId: string) => void
  onRemoveSigner: (credentialId: string) => void
}) {
  const busy = Boolean(busyLabel)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-4">
      <SettingsScreenHeader
        title="Signers"
        onBack={onBack}
        rightAction={
          <button
            type="button"
            onClick={onAddBackupPasskey}
            disabled={busy}
            aria-label="Add backup passkey"
            className="grid size-5 shrink-0 place-items-center text-primary disabled:opacity-50"
          >
            <Plus className="size-5" aria-hidden />
          </button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col justify-between gap-4">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <p className="text-sm leading-[1.36] tracking-[-0.28px] text-[#b3b3b3]">
            Any passkey listed here can approve transactions for this wallet on its own, and can
            restore it on a new device.
          </p>

          {error ? (
            <div className="flex w-full flex-col gap-2 rounded-[14px] bg-[#2a2928] p-3">
              <p className="text-sm leading-[1.36] tracking-[-0.28px] text-[#ea471e]">{error}</p>
              {onReverify ? (
                <button
                  type="button"
                  onClick={onReverify}
                  disabled={busy}
                  className="self-start text-xs font-medium text-primary disabled:opacity-50"
                >
                  Verify with your current passkey
                </button>
              ) : null}
            </div>
          ) : null}

          {loading && signers.length === 0 ? (
            <p className="rounded-[14px] bg-[#2a2928] p-4 text-sm text-[#b3b3b3]">
              Loading signers…
            </p>
          ) : null}

          {!loading && signers.length === 0 ? (
            <p className="rounded-[14px] bg-[#2a2928] p-4 text-sm text-[#b3b3b3]">
              No passkeys are recorded for this wallet on this device.
            </p>
          ) : null}

          {signers.length > 0 ? (
            <div className="flex flex-col gap-2">
              {signers.map((signer) => (
                <AccountSignerRow
                  key={signer.credentialId}
                  signer={signer}
                  busy={busy}
                  onFinishSetup={
                    signer.status === 'pending'
                      ? () => onFinishSetup(signer.credentialId)
                      : undefined
                  }
                  onRemove={
                    signer.role === 'backup' ? () => onRemoveSigner(signer.credentialId) : undefined
                  }
                />
              ))}
            </div>
          ) : null}

          <p className="text-xs leading-[1.34] tracking-[-0.12px] text-[#8a8a8a]">
            This list shows the passkeys added on this device. Backup passkeys added elsewhere still
            work, but will not appear here.
          </p>
        </div>

        <OnboardingPrimaryButton disabled={busy} onClick={onAddBackupPasskey}>
          Add Backup Passkey
        </OnboardingPrimaryButton>
      </div>

      {busyLabel ? (
        <LatchLoadingOverlay
          label={busyLabel}
          description="Approve the request with your passkey when prompted. Keep this window open."
        />
      ) : null}
    </div>
  )
}
