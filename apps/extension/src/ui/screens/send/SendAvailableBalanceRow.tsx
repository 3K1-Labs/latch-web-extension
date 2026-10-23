import React from 'react'

export function SendAvailableBalanceRow({
  balance,
  symbol,
  disabled = false,
  onMax,
}: {
  balance: string
  symbol: string
  disabled?: boolean
  onMax: () => void
}) {
  return (
    <div className="flex w-full shrink-0 items-center gap-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-normal leading-[1.34] tracking-[-0.24px] text-[#b3b3b3]">
          Available To Send
        </p>
        <p className="truncate text-base font-semibold leading-[1.31] tracking-[-0.16px] text-[#fcfcfc]">
          {balance} {symbol}
        </p>
      </div>
      <button
        type="button"
        onClick={onMax}
        disabled={disabled}
        className="relative flex h-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[#2b2a29] px-5 shadow-[0px_12px_13.1px_-8px_rgba(56,56,56,0.1)] disabled:opacity-50"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[10px] bg-[#383838]"
        />
        <span className="relative text-xs font-medium leading-[1.3] tracking-[-0.12px] text-[#d7d7d7]">
          Max
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[10px] shadow-[inset_0px_2px_4px_0px_rgba(255,255,255,0.26)]"
        />
      </button>
    </div>
  )
}
