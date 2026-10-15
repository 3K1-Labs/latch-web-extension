import React, { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'

import copyIconUrl from 'url:../../../assets/home/icon-copy.svg'

const COPIED_MS = 2000

export function useCopiedFlag() {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function markCopied() {
    setCopied(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setCopied(false)
      timeoutRef.current = null
    }, COPIED_MS)
  }

  return { copied, markCopied }
}

export function CopyGlyph({
  copied,
  className = 'size-4',
}: {
  copied: boolean
  className?: string
}) {
  if (copied) {
    return (
      <Check
        className={['shrink-0 text-[#FFAD00]', className].join(' ')}
        strokeWidth={2}
        aria-hidden
      />
    )
  }
  return (
    <img
      src={copyIconUrl}
      alt=""
      className={['shrink-0 object-contain', className].join(' ')}
      aria-hidden
    />
  )
}

export function CopyIconButton({
  text,
  idleLabel = 'Copy address',
  className,
  iconClassName = 'size-4',
  disabled = false,
  stopPropagation = false,
  menuAnchor = false,
}: {
  text: string
  idleLabel?: string
  className?: string
  iconClassName?: string
  disabled?: boolean
  stopPropagation?: boolean
  menuAnchor?: boolean
}) {
  const { copied, markCopied } = useCopiedFlag()
  const blocked = disabled || !text || text === '—'

  return (
    <button
      type="button"
      disabled={blocked}
      data-account-menu-copy={menuAnchor ? 'true' : undefined}
      className={[
        'inline-flex shrink-0 items-center justify-center disabled:opacity-30',
        className ?? '',
      ].join(' ')}
      aria-label={copied ? 'Copied' : idleLabel}
      onClick={(e) => {
        if (stopPropagation) {
          e.preventDefault()
          e.stopPropagation()
        }
        if (blocked) return
        void navigator.clipboard.writeText(text).then(() => {
          markCopied()
        })
      }}
      onPointerDown={
        stopPropagation
          ? (e) => {
              e.preventDefault()
              e.stopPropagation()
            }
          : undefined
      }
    >
      <CopyGlyph copied={copied} className={iconClassName} />
    </button>
  )
}
