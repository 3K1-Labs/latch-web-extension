import React from 'react'

import qrIconUrl from 'url:../../../../assets/receive/icon-qr.svg'

import { CopyIconButton } from '../../components/CopyIconButton'
import { TokenAvatar } from '../../components/TokenAvatar'
import { formatDisplayAmount2dp } from '../../lib/formatDisplay'

export interface ReceiveToken {
  id: string
  name: string
  balance: string
  symbol: string
  address: string
  iconUrl?: string | null
}

export function ReceiveTokenCard({
  token,
  onSelect,
}: {
  token: ReceiveToken
  onSelect: () => void
}) {
  return (
    <div className="flex w-full items-center gap-2 rounded-[14px] bg-[#2a2928] p-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <TokenAvatar
          symbol={token.symbol}
          iconUrl={token.iconUrl}
          className="size-8 border-0 bg-[#1e1e1e] p-1"
          rounded="rounded-lg"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-base font-semibold leading-[1.31] tracking-[-0.16px] text-[#fcfcfc]">
            {token.name}
          </p>
          <div className="flex items-center gap-2 text-sm">
            <span className="shrink-0 font-normal leading-[1.34] tracking-[-0.28px] text-[#b3b3b3]">
              BALANCE
            </span>
            <span className="min-w-0 flex-1 truncate font-medium leading-[1.3] tracking-[-0.14px] text-[#fbfbfb]">
              {formatDisplayAmount2dp(token.balance)} {token.symbol}
            </span>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onSelect}
        className="size-5 shrink-0"
        aria-label={`Show ${token.name} receive QR code`}
      >
        <img src={qrIconUrl} alt="" className="size-5" aria-hidden />
      </button>

      <CopyIconButton text={token.address} className="size-5" iconClassName="size-5" />
    </div>
  )
}
