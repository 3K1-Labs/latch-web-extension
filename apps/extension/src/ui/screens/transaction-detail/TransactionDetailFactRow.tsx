import React from 'react'

import { CopyIconButton } from '../../components/CopyIconButton'

export function TransactionDetailFactRow({
  label,
  value,
  copyable,
  isLast,
}: {
  label: string
  value: string
  copyable?: boolean
  isLast?: boolean
}) {
  return (
    <div
      className={[
        'flex items-center justify-between gap-3 py-4',
        !isLast ? 'border-b border-[#2C2C2E]' : '',
      ].join(' ')}
    >
      <span className="text-[14px] text-[#8E8E93]">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[14px] font-semibold text-white">{value}</span>
        {copyable ? (
          <CopyIconButton
            text={value}
            idleLabel={`Copy ${label}`}
            iconClassName="h-[15px] w-[15px]"
            className="text-[#8E8E93] hover:text-white transition-colors"
          />
        ) : null}
      </div>
    </div>
  )
}
