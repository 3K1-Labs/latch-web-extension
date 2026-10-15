import React from 'react'

interface SettingsToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  ariaLabel?: string
}

export function SettingsToggle({ checked, onChange, ariaLabel = 'Toggle' }: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={[
        'relative h-7 w-16 shrink-0 overflow-hidden rounded-full outline-none',
        checked ? 'bg-[#FFAD00]' : 'bg-[#383838]',
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-[2px] h-6 w-[39px] rounded-full bg-white transition-all duration-200',
          checked ? 'left-[23px]' : 'left-[2px]',
        ].join(' ')}
      />
    </button>
  )
}
