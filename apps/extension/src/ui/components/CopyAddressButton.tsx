import React from 'react'

import { CopyIconButton } from './CopyIconButton'

export function CopyAddressButton({
  address,
  className,
  /** Set when used inside Radix DropdownMenuItem so copy click does not select the row. */
  menuAnchor = false,
}: {
  address: string
  className?: string
  menuAnchor?: boolean
}) {
  return (
    <CopyIconButton
      text={address}
      className={[
        'text-primary hover:opacity-90 disabled:pointer-events-none',
        className ?? '',
      ].join(' ')}
      iconClassName="h-[18px] w-[18px]"
      stopPropagation={menuAnchor}
      menuAnchor={menuAnchor}
    />
  )
}
