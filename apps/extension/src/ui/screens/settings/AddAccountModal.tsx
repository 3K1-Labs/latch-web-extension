import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import closeIconUrl from 'url:../../../../assets/home/icon-close.svg'

type AddAccountOption = 'smartAccount' | 'multisig' | 'existingMultisig'

function AddAccountOptionCard({
  title,
  description,
  selected,
  onClick,
}: {
  title: string
  description: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full rounded-[14px] bg-[#2a2928] p-3 text-left transition-colors',
        selected ? 'border border-[#f0a300]' : 'border border-transparent',
      ].join(' ')}
    >
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-semibold leading-[1.31] tracking-[-0.16px] text-[#fcfcfc]">
          {title}
        </p>
        <p className="text-sm font-normal leading-[1.34] tracking-[-0.28px] text-[#b3b3b3]">
          {description}
        </p>
      </div>
    </button>
  )
}

export function AddAccountModal({
  isOpen,
  onClose,
  onSelectSmartAccount,
  onSelectMultisig,
  onSelectExistingMultisig,
}: {
  isOpen: boolean
  onClose: () => void
  onSelectSmartAccount: () => void
  onSelectMultisig: () => void
  onSelectExistingMultisig: () => void
}) {
  const [selected, setSelected] = useState<AddAccountOption | null>(null)

  useEffect(() => {
    if (!isOpen) setSelected(null)
  }, [isOpen])

  if (!isOpen) return null

  const handleClose = () => {
    setSelected(null)
    onClose()
  }

  const handleSelect = (option: AddAccountOption) => {
    setSelected(option)
    if (option === 'smartAccount') {
      onSelectSmartAccount()
      return
    }
    if (option === 'existingMultisig') {
      onSelectExistingMultisig()
      return
    }
    onSelectMultisig()
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <button
        type="button"
        className="absolute inset-0 bg-[#121212]/90"
        aria-label="Close add account dialog"
        onClick={handleClose}
      />
      <div
        className="relative z-10 w-full max-w-[354px] rounded-[18px] bg-[#222121] px-3 py-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-account-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex w-full flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <h2
              id="add-account-title"
              className="min-w-0 flex-1 text-[22px] font-medium leading-[1.32] tracking-[-0.44px] text-[#fcfcfc]"
            >
              Add Account
            </h2>
            <button
              type="button"
              onClick={handleClose}
              className="relative size-5 shrink-0"
              aria-label="Close"
            >
              <img
                src={closeIconUrl}
                alt=""
                className="pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2"
              />
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <AddAccountOptionCard
              title="Create Smart Account"
              description="Set up a smart account with advanced security and flexible permissions."
              selected={selected === 'smartAccount'}
              onClick={() => handleSelect('smartAccount')}
            />
            <AddAccountOptionCard
              title="Create a MultiSig Wallet"
              description="Create a wallet that requires multiple approvals."
              selected={selected === 'multisig'}
              onClick={() => handleSelect('multisig')}
            />
            <AddAccountOptionCard
              title="Add existing MultiSig"
              description="Paste the address of a MultiSig wallet you already co-own."
              selected={selected === 'existingMultisig'}
              onClick={() => handleSelect('existingMultisig')}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
