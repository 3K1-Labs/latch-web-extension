import React from 'react'

import { CopyGlyph, useCopiedFlag } from '../../components/CopyIconButton'
import { truncateMiddle } from '../../lib/sendAddress'

export function ReceiveAddressCopyButton({ address }: { address: string }) {
  const { copied, markCopied } = useCopiedFlag()
  const displayAddress = address ? truncateMiddle(address, 9, 6) : ''

  const handleCopy = () => {
    if (!address) return
    void navigator.clipboard.writeText(address).then(() => {
      markCopied()
    })
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={!address}
      className="relative flex h-12 w-full shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[32px] border border-[#f0a300] px-5 py-3 text-base font-semibold leading-[1.31] tracking-[-0.16px] text-[#121212] shadow-[0px_12px_13.1px_-8px_rgba(246,139,7,0.1)] disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={copied ? 'Copied' : 'Copy address'}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[32px] bg-[#ffad00]"
      />
      <span className="relative whitespace-nowrap">{displayAddress}</span>
      <CopyGlyph copied={copied} className="relative h-4 w-4" />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[32px] shadow-[inset_0px_2px_4px_0px_rgba(255,255,255,0.26)]"
      />
    </button>
  )
}
