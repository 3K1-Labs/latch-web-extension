import React from 'react'

import chevronRightUrl from 'url:../../../../assets/home/icon-chevron-right.svg'
import userAvatarUrl from 'url:../../../../assets/icons/user.png'

import { CopyIconButton } from '../../components/CopyIconButton'

interface ProfileCardProps {
  name: string
  address: string
  onClick?: () => void
}

export function ProfileCard({ name, address, onClick }: ProfileCardProps) {
  const shortAddress =
    address.length > 12 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-[14px] bg-[#2a2928] px-3 py-3 text-left"
    >
      <div className="flex items-center gap-2">
        <div className="size-10 shrink-0 overflow-hidden rounded-[32px]">
          <img src={userAvatarUrl} alt="" className="size-full object-cover" />
        </div>
        <div className="flex flex-col items-start gap-0.5">
          <div className="text-xl font-semibold leading-[1.31] tracking-[-0.4px] text-[#fcfcfc]">
            {name}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-sm font-normal leading-[1.34] tracking-[-0.28px] text-[#b3b3b3]">
              {shortAddress}
            </span>
            <CopyIconButton text={address} className="size-4" stopPropagation />
          </div>
        </div>
      </div>
      <img src={chevronRightUrl} alt="" className="size-6 shrink-0" aria-hidden />
    </button>
  )
}
