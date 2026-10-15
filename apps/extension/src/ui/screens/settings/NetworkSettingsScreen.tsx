import React from 'react'

function SettingsFormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-1">
      <span className="text-base font-semibold leading-[1.31] tracking-[-0.16px] text-[#fcfcfc]">
        {label}
      </span>
      {children}
    </div>
  )
}

/** Read-only. The network follows the deployment; developer mode is the switch. */
export function NetworkSettingsScreen({
  networkLabel,
  onBack,
}: {
  networkLabel: string
  onBack: () => void
}) {
  return (
    <div className="flex w-full flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-sm text-[#fcfcfc]/opacity-70"
      >
        Back
      </button>
      <h2 className="text-lg font-semibold tracking-[-0.32px] text-[#fcfcfc]">Network</h2>
      <SettingsFormField label="Current">
        <span className="text-base tracking-[-0.32px] text-[#fcfcfc]">{networkLabel}</span>
      </SettingsFormField>
    </div>
  )
}
