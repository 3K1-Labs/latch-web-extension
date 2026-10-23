import React from 'react'

export function SendSummarySubmitButton({
  loading,
  disabled = false,
  onSend,
  label = 'Send',
}: {
  loading: boolean
  disabled?: boolean
  onSend: () => void
  label?: string
}) {
  return (
    <button
      type="button"
      disabled={loading || disabled}
      onClick={onSend}
      className="relative flex h-12 w-full shrink-0 items-center justify-center overflow-hidden rounded-[32px] border border-[#f0a300] px-5 py-3 text-base font-semibold leading-[1.31] tracking-[-0.16px] text-[#121212] shadow-[0px_12px_13.1px_-8px_rgba(246,139,7,0.1)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[32px] bg-[#ffad00]"
      />
      <span className="relative">{label}</span>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[32px] shadow-[inset_0px_2px_4px_0px_rgba(255,255,255,0.26)]"
      />
    </button>
  )
}
