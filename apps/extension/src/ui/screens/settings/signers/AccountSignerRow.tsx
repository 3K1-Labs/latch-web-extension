import type { AccountSignerRecord } from '@latch/types'

import biometricsIconUrl from 'url:../../../../../assets/icons/biometrics.svg'

/** Credential ids are long base64url strings; show just enough to tell two apart. */
function truncateCredentialId(credentialId: string): string {
  if (credentialId.length <= 14) return credentialId
  return `${credentialId.slice(0, 8)}…${credentialId.slice(-4)}`
}

function badgeFor(signer: AccountSignerRecord): { label: string; className: string } {
  if (signer.status === 'pending') {
    return { label: 'Setup incomplete', className: 'bg-[rgba(255,173,0,0.08)] text-primary' }
  }
  if (signer.role === 'primary') {
    return { label: 'This device', className: 'bg-[rgba(255,173,0,0.08)] text-primary' }
  }
  return { label: 'Backup', className: 'bg-[rgba(62,233,107,0.08)] text-[#3ee96b]' }
}

export function AccountSignerRow({
  signer,
  busy,
  onFinishSetup,
  onRemove,
}: {
  signer: AccountSignerRecord
  busy?: boolean
  onFinishSetup?: () => void
  onRemove?: () => void
}) {
  const badge = badgeFor(signer)
  const label = signer.label?.trim() || (signer.role === 'primary' ? 'Wallet passkey' : 'Passkey')

  return (
    <div className="flex w-full items-center gap-2 rounded-[14px] bg-[#2a2928] p-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-[#1e1e1e] p-1">
          <img src={biometricsIconUrl} alt="" className="h-5 w-5 object-contain" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate text-base font-semibold leading-[1.31] tracking-[-0.16px] text-[#fcfcfc]">
              {label}
            </span>
            <span
              className={[
                'shrink-0 rounded-lg px-2 py-1 text-xs font-medium',
                badge.className,
              ].join(' ')}
            >
              {badge.label}
            </span>
          </div>
          <span className="truncate font-mono text-xs text-[#b3b3b3]">
            {truncateCredentialId(signer.credentialId)}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {onFinishSetup ? (
          <button
            type="button"
            onClick={onFinishSetup}
            disabled={busy}
            className="shrink-0 text-xs font-medium text-primary disabled:opacity-50"
          >
            Finish setup
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Remove ${label}`}
            className="shrink-0 text-xs font-medium text-[#b3b3b3] transition-colors hover:text-[#ea471e] disabled:opacity-50"
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  )
}
