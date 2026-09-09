import React from 'react'
import { createPortal } from 'react-dom'

export function ConfirmRemoveAccountModal({
  isOpen,
  accountName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean
  accountName: string
  busy?: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!isOpen) return null

  const displayName = accountName.trim() || 'this account'

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <button
        type="button"
        className="absolute inset-0 bg-[#121212]/90"
        aria-label="Close dialog"
        onClick={onCancel}
      />
      <div
        className="relative z-10 w-full max-w-[372px] rounded-[18px] bg-[#2e2e2e] px-3 py-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-account-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex w-full flex-col gap-3">
          <div className="flex flex-col gap-2 text-center">
            <h2
              id="remove-account-modal-title"
              className="text-xl font-semibold leading-[1.31] tracking-[-0.4px] text-[#fcfcfc]"
            >
              Remove Account
            </h2>
            <p className="text-base leading-[1.36] tracking-[-0.32px] text-[#b3b3b3]">
              Removing <span className="font-bold text-[#fcfcfc]">{displayName}</span> only takes it
              off this Latch install. The account still exists on Stellar, and you can add it again
              later.
            </p>
          </div>
          {error ? (
            <p className="text-center text-sm leading-[1.36] tracking-[-0.28px] text-[#ea471e]">
              {error}
            </p>
          ) : null}
          <div className="flex w-full gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="relative flex h-11 flex-1 items-center justify-center overflow-hidden rounded-[32px] border border-[#2b2a29] bg-[#383838] px-5 text-sm font-medium tracking-[-0.14px] text-[#d7d7d7] shadow-[0px_12px_13.1px_-8px_rgba(56,56,56,0.1)] disabled:opacity-60"
            >
              No, Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="relative flex h-11 flex-1 items-center justify-center overflow-hidden rounded-[32px] border border-[#e23a10] bg-[#ea471e] px-5 text-sm font-medium tracking-[-0.14px] text-[#121212] shadow-[0px_12px_13.1px_-8px_rgba(246,139,7,0.1)] disabled:opacity-60"
            >
              {busy ? 'Removing…' : 'Yes, Remove'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
