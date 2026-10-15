import React, { type ClipboardEvent } from 'react'
import { QRCodeSVG } from 'qrcode.react'

import type { MultisigAccount, MultisigPendingInvite } from '@latch/types'

import { useCopiedFlag } from '../../components/CopyIconButton'
import { parseInviteTokenFromInput } from '../../lib/cosignDeepLink'

import { OnboardingPrimaryButton } from '../../onboarding/components/OnboardingCardButtons'
import { SettingsScreenHeader } from '../settings/SettingsScreenHeader'

export function MultisigWalletsScreen({
  deployed,
  pendingInvites,
  joinCode,
  joinCodeError,
  onBack,
  onOpenDeployed,
  onOpenPendingInvite,
  onJoinCodeChange,
  onSubmitJoinCode,
  onRemovePendingInvite,
}: {
  deployed: MultisigAccount[]
  pendingInvites: MultisigPendingInvite[]
  joinCode: string
  joinCodeError: string | null
  onBack: () => void
  onOpenDeployed: (account: MultisigAccount) => void
  onOpenPendingInvite: (invite: MultisigPendingInvite) => void
  onJoinCodeChange: (code: string) => void
  onSubmitJoinCode: () => void
  onRemovePendingInvite: (token: string) => void
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SettingsScreenHeader title="Multisig Wallets" onBack={onBack} />
      <div className="mt-6 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-4">
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#b3b3b3]">
            Your wallets
          </h2>
          {deployed.length === 0 ? (
            <p className="rounded-[14px] bg-[#2a2928] p-4 text-sm text-[#b3b3b3]">
              No deployed multisig wallets yet.
            </p>
          ) : (
            deployed.map((account) => (
              <button
                key={account.smartAccountAddress}
                type="button"
                onClick={() => onOpenDeployed(account)}
                className="flex w-full flex-col gap-1 rounded-[14px] bg-[#2a2928] p-4 text-left"
              >
                <span className="font-semibold text-[#fcfcfc]">
                  {account.label ?? 'Multisig wallet'}
                </span>
                <span className="font-mono text-xs text-[#b3b3b3]">
                  {truncate(account.smartAccountAddress)}
                </span>
                {account.threshold != null ? (
                  <span className="text-xs text-primary">Threshold {account.threshold}</span>
                ) : null}
              </button>
            ))
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#b3b3b3]">
            Pending invites
          </h2>
          {pendingInvites.length === 0 ? (
            <p className="rounded-[14px] bg-[#2a2928] p-4 text-sm text-[#b3b3b3]">
              No pending invites.
            </p>
          ) : (
            pendingInvites.map((invite) => (
              <div
                key={invite.token}
                className="flex items-center gap-2 rounded-[14px] bg-[#2a2928] p-4"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onOpenPendingInvite(invite)}
                >
                  <span className="block font-semibold text-[#fcfcfc]">
                    {invite.walletName ?? 'Multisig invite'}
                  </span>
                  <span className="text-xs text-[#b3b3b3]">Waiting for deploy</span>
                </button>
                <button
                  type="button"
                  className="text-xs text-[#b3b3b3]"
                  onClick={() => onRemovePendingInvite(invite.token)}
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#b3b3b3]">
            Join with code
          </h2>
          <input
            value={joinCode}
            onChange={(e) => onJoinCodeChange(e.target.value)}
            onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
              const text = e.clipboardData.getData('text/plain')
              const token = parseInviteTokenFromInput(text)
              if (!token) return
              e.preventDefault()
              onJoinCodeChange(token)
            }}
            placeholder="Paste invite link or code"
            className="h-[52px] w-full rounded-xl border border-[#383838] bg-transparent px-3 text-base text-[#fcfcfc] outline-none placeholder:text-[#b3b3b3]"
          />
          {joinCodeError ? <p className="text-sm text-red-400">{joinCodeError}</p> : null}
          <OnboardingPrimaryButton disabled={!joinCode.trim()} onClick={onSubmitJoinCode}>
            Open invite
          </OnboardingPrimaryButton>
        </section>
      </div>
    </div>
  )
}

function truncate(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

export function MultisigInviteShareCard({
  inviteUrl,
  inviteToken,
}: {
  inviteUrl: string
  inviteToken: string
}) {
  const linkCopy = useCopiedFlag()
  const codeCopy = useCopiedFlag()

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-dashed border-[#383838] bg-[#2a2928] p-4">
      <p className="text-base font-semibold text-[#fcfcfc]">Invite owners</p>
      <p className="text-sm text-[#b3b3b3]">
        Share the link or invite code so co-owners can join this wallet.
      </p>
      <div className="flex justify-center py-2">
        <QRCodeSVG value={inviteUrl} size={120} bgColor="transparent" fgColor="#fcfcfc" />
      </div>
      <button
        type="button"
        className="text-sm font-medium text-primary"
        aria-label={linkCopy.copied ? 'Copied' : 'Copy invite link'}
        onClick={() => {
          void navigator.clipboard.writeText(inviteUrl).then(() => {
            linkCopy.markCopied()
          })
        }}
      >
        {linkCopy.copied ? 'Copied link' : 'Copy invite link'}
      </button>
      <button
        type="button"
        className="text-sm font-medium text-primary"
        aria-label={codeCopy.copied ? 'Copied' : 'Copy invite code'}
        onClick={() => {
          void navigator.clipboard.writeText(inviteToken).then(() => {
            codeCopy.markCopied()
          })
        }}
      >
        {codeCopy.copied ? 'Copied code' : 'Copy invite code'}
      </button>
      <p className="break-all font-mono text-xs text-[#b3b3b3]">{inviteToken}</p>
    </div>
  )
}
