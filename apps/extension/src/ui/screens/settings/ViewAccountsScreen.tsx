import React, { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import type { AccountMode } from '@latch/types'

import copyIconUrl from 'url:../../../../assets/home/icon-copy.svg'
import multisigIconUrl from 'url:../../../../assets/home/settings-multisig.svg'
import userAvatarUrl from 'url:../../../../assets/icons/user.png'

import { AccountRadio } from './AccountRadio'
import { AddAccountFlow } from './add-account/AddAccountFlow'
import { AddAccountModal } from './AddAccountModal'
import { ConfirmRemoveAccountModal } from './ConfirmRemoveAccountModal'
import { SettingsScreenHeader } from './SettingsScreenHeader'

export type ViewAccountItem = {
  id: string
  name: string
  address: string
  mode?: AccountMode
}

function truncateAddress(address: string) {
  if (address.length <= 12) return address
  return `${address.slice(0, 4)}...${address.slice(-4)}`
}

function AccountListRow({
  name,
  address,
  mode,
  selected,
  onSelect,
  onRemove,
}: {
  name: string
  address: string
  mode?: ViewAccountItem['mode']
  selected: boolean
  onSelect: () => void
  onRemove?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const disabled = !address || address === '—'

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center justify-between rounded-[14px] bg-[#2a2928] px-3 py-3 text-left"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="size-10 shrink-0 overflow-hidden rounded-[32px]">
          <img
            src={mode === 'multisig' ? multisigIconUrl : userAvatarUrl}
            alt=""
            className="size-full object-cover"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xl font-semibold tracking-[-0.4px] text-[#fcfcfc]">
            {name}
          </span>
          <div className="flex items-center gap-1">
            <span className="truncate text-sm tracking-[-0.28px] text-[#b3b3b3]">
              {truncateAddress(address)}
            </span>
            <button
              type="button"
              disabled={disabled}
              aria-label={copied ? 'Copied' : 'Copy address'}
              className="inline-flex size-4 shrink-0 items-center justify-center disabled:opacity-30"
              onClick={(e) => {
                e.stopPropagation()
                if (disabled) return
                void navigator.clipboard.writeText(address).then(() => {
                  setCopied(true)
                  if (timeoutRef.current) clearTimeout(timeoutRef.current)
                  timeoutRef.current = setTimeout(() => {
                    setCopied(false)
                    timeoutRef.current = null
                  }, 2000)
                })
              }}
            >
              <img src={copyIconUrl} alt="" className="size-4" />
            </button>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {onRemove ? (
          <button
            type="button"
            aria-label={`Remove ${name}`}
            className="inline-flex size-4 shrink-0 items-center justify-center text-[#b3b3b3] transition-colors hover:text-[#ea471e]"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            <Trash2 className="size-4" strokeWidth={1.5} />
          </button>
        ) : null}
        <AccountRadio selected={selected} />
      </div>
    </button>
  )
}

export function ViewAccountsScreen({
  surface,
  accounts,
  activeAccountId,
  onBack,
  onSave,
  onAccountsChanged,
  onCreateMultisig,
  onDeleteAccount,
  onAddExistingMultisig,
}: {
  surface: 'popup' | 'sidepanel'
  accounts: ViewAccountItem[]
  activeAccountId?: string
  onBack: () => void
  onSave: (accountId: string) => void
  onAccountsChanged: () => void
  onCreateMultisig: () => void
  onDeleteAccount: (accountId: string) => Promise<void>
  onAddExistingMultisig: () => void
}) {
  const [selectedAccountId, setSelectedAccountId] = useState(
    activeAccountId ?? accounts[0]?.id ?? ''
  )
  const [addAccountModalOpen, setAddAccountModalOpen] = useState(false)
  const [addAccountFlowOpen, setAddAccountFlowOpen] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<ViewAccountItem | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | undefined>(undefined)
  const canSave = selectedAccountId !== activeAccountId && selectedAccountId.length > 0

  async function confirmRemoval() {
    if (!pendingRemoval) return
    setRemoving(true)
    setRemoveError(undefined)
    try {
      await onDeleteAccount(pendingRemoval.id)
      if (selectedAccountId === pendingRemoval.id) {
        setSelectedAccountId(activeAccountId ?? '')
      }
      setPendingRemoval(null)
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Could not remove this account.')
    } finally {
      setRemoving(false)
    }
  }

  if (addAccountFlowOpen) {
    return (
      <AddAccountFlow
        surface={surface}
        onBack={() => setAddAccountFlowOpen(false)}
        onComplete={() => setAddAccountFlowOpen(false)}
        onAccountsChanged={onAccountsChanged}
      />
    )
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col gap-4">
      <SettingsScreenHeader
        title="View Accounts"
        onBack={onBack}
        rightAction={
          <button
            type="button"
            onClick={() => setAddAccountModalOpen(true)}
            className="flex size-5 shrink-0 items-center justify-center"
            aria-label="Add account"
          >
            <Plus className="size-5 text-[#cdcdcd]" strokeWidth={1.5} />
          </button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col justify-between">
        <div className="flex w-full flex-col gap-2">
          {accounts.map((account) => (
            <AccountListRow
              key={account.id}
              name={account.name}
              address={account.address}
              mode={account.mode}
              selected={account.id === selectedAccountId}
              onSelect={() => setSelectedAccountId(account.id)}
              onRemove={() => {
                setRemoveError(undefined)
                setPendingRemoval(account)
              }}
            />
          ))}
        </div>

        <button
          type="button"
          disabled={!canSave}
          onClick={() => onSave(selectedAccountId)}
          className={[
            'relative mt-4 h-12 w-full shrink-0 rounded-[32px] border px-5 py-3 text-base font-semibold tracking-[-0.16px] transition-all',
            canSave
              ? 'cursor-pointer border-[#f0a300] bg-primary text-[#121212] opacity-100 shadow-[0px_12px_13.1px_-8px_rgba(246,139,7,0.1)] hover:brightness-105 active:scale-[0.98]'
              : 'pointer-events-none cursor-not-allowed border-[#2b2a29] bg-[#383838] text-[#d7d7d7] opacity-0 shadow-[0px_12px_13.1px_-8px_rgba(56,56,56,0.1)]',
          ].join(' ')}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0px_2px_4px_0px_rgba(255,255,255,0.26)]"
          />
          Save Changes
        </button>
      </div>

      <AddAccountModal
        isOpen={addAccountModalOpen}
        onClose={() => setAddAccountModalOpen(false)}
        onSelectSmartAccount={() => {
          setAddAccountModalOpen(false)
          setAddAccountFlowOpen(true)
        }}
        onSelectMultisig={() => {
          setAddAccountModalOpen(false)
          onCreateMultisig()
        }}
        onSelectExistingMultisig={() => {
          setAddAccountModalOpen(false)
          onAddExistingMultisig()
        }}
      />

      <ConfirmRemoveAccountModal
        isOpen={Boolean(pendingRemoval)}
        accountName={pendingRemoval?.name ?? ''}
        busy={removing}
        error={removeError}
        onCancel={() => {
          if (removing) return
          setPendingRemoval(null)
          setRemoveError(undefined)
        }}
        onConfirm={() => void confirmRemoval()}
      />
    </div>
  )
}
