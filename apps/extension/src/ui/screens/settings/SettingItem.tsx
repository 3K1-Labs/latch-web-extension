import React from 'react'

import chevronRightUrl from 'url:../../../../assets/home/icon-chevron-right.svg'

interface SettingItemProps {
  icon: React.ReactNode
  label: React.ReactNode
  onClick?: () => void
  rightElement?: React.ReactNode
  danger?: boolean
  showChevron?: boolean
}

export function SettingItem({
  icon,
  label,
  onClick,
  rightElement,
  danger,
  showChevron = true,
}: SettingItemProps) {
  const Component = onClick ? 'button' : 'div'

  return (
    <Component
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2 rounded-[14px] bg-[#2a2928] p-3 text-left',
        onClick ? 'cursor-pointer' : '',
      ].join(' ')}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-[#1e1e1e] p-1">
          {icon}
        </div>
        <div
          className={[
            'min-w-0 flex-1 text-sm font-normal leading-[1.34] tracking-[-0.28px]',
            danger ? 'text-[#ea471e]' : 'text-[#fcfcfc]',
          ].join(' ')}
        >
          {label}
        </div>
      </div>
      {rightElement ??
        (showChevron ? (
          <img src={chevronRightUrl} alt="" className="size-6 shrink-0" aria-hidden />
        ) : null)}
    </Component>
  )
}
