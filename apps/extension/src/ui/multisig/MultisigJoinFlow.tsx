import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { MultisigJoinPreviewResponse, StoredAccount } from '@latch/types'

import { friendlyError, sendToBackground } from '../lib/backgroundClient'
import { formatMultisigInviteError } from '../lib/multisigErrors'
import { apiSyncLocalMultisigAccounts } from '../lib/multisigFlow'
import {
  findDraftMemberByCredentialId,
  findDraftMemberForStoredAccount,
  isDuplicateMultisigMemberError,
  walletNameFromJoinPreview,
} from '../lib/multisigJoinHelpers'
import {
  addStoredPasskeyToJoin,
  enrollNewPasskeyForJoin,
  listReusablePasskeyAccounts,
} from '../lib/multisigPasskey'
import { storedAccountLabel } from '../lib/storedAccountLabel'
import { JoinMultisigScreen } from '../screens/multisig/JoinMultisigScreen'
import { OnboardingPrimaryButton } from '../onboarding/components/OnboardingCardButtons'
import { toMultisigPasskeyOptions } from './MultisigPasskeyPicker'

export type MultisigJoinWebauthnSurface = 'popup' | 'sidepanel'

export function MultisigJoinFlow({
  token,
  accounts,
  surface,
  onJoined,
  onAccountsSynced,
  onBack,
  hideBack,
}: {
  token: string
  accounts: StoredAccount[]
  surface: MultisigJoinWebauthnSurface
  onJoined?: () => void
  onAccountsSynced?: () => void | Promise<void>
  onBack?: () => void
  hideBack?: boolean
}) {
  const [preview, setPreview] = useState<MultisigJoinPreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [joinBusy, setJoinBusy] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)
  const [walletSynced, setWalletSynced] = useState(false)

  const reusablePasskeyAccounts = useMemo(() => listReusablePasskeyAccounts(accounts), [accounts])
  const [selectedPasskeyAccountId, setSelectedPasskeyAccountId] = useState<string | undefined>()
  const passkeyPickerOptions = useMemo(
    () =>
      toMultisigPasskeyOptions(reusablePasskeyAccounts, (account, index) => {
        const i = accounts.findIndex((a) => a.id === account.id)
        return storedAccountLabel(account, i >= 0 ? i : index)
      }),
    [reusablePasskeyAccounts, accounts]
  )
  const selectedPasskeyAccount = useMemo(
    () => reusablePasskeyAccounts.find((a) => a.id === selectedPasskeyAccountId),
    [reusablePasskeyAccounts, selectedPasskeyAccountId]
  )

  useEffect(() => {
    if (reusablePasskeyAccounts.length === 0) {
      setSelectedPasskeyAccountId(undefined)
      return
    }
    setSelectedPasskeyAccountId((prev) =>
      prev && reusablePasskeyAccounts.some((a) => a.id === prev)
        ? prev
        : reusablePasskeyAccounts[0]!.id
    )
  }, [reusablePasskeyAccounts])

  const loadJoinPreview = useCallback(async (joinToken: string) => {
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const res = await sendToBackground<{ token: string }, MultisigJoinPreviewResponse>({
        type: 'MULTISIG_JOIN_PREVIEW',
        payload: { token: joinToken },
      })
      if (!res.ok || !res.data) throw new Error(friendlyError(res.error))
      setPreview(res.data)
      return res.data
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setPreviewError(formatMultisigInviteError(raw))
      return null
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadJoinPreview(token)
  }, [token, loadJoinPreview])

  async function completeJoin(
    enroll: () => Promise<{ draft: import('@latch/types').MultisigDraft; credentialId: string }>
  ) {
    setJoinBusy(true)
    setJoinError(null)
    try {
      const { draft, credentialId } = await enroll()
      const latest = await loadJoinPreview(token)
      const members = latest?.members ?? latest?.draft?.members ?? draft.members ?? []
      const member =
        findDraftMemberByCredentialId(draft, credentialId) ??
        findDraftMemberByCredentialId(
          { members } as import('@latch/types').MultisigDraft,
          credentialId
        )
      await sendToBackground({
        type: 'MULTISIG_ADD_PENDING_INVITE',
        payload: {
          token,
          joinedAt: Date.now(),
          walletName: walletNameFromJoinPreview(latest ?? draft),
          draftId: draft.id ?? latest?.draft?.id,
          multisigMemberId: member?.id,
          passkeyCredentialId: credentialId,
          threshold: latest?.threshold ?? latest?.draft?.threshold ?? draft.threshold,
          membersSnapshot: members,
          smartAccountAddress: draft.smartAccountAddress ?? latest?.draft?.smartAccountAddress,
        },
      })
      const sync = await apiSyncLocalMultisigAccounts({ activateFirstCreated: true })
      setWalletSynced(sync.created.length > 0 || sync.updated)
      await onAccountsSynced?.()
      onJoined?.()
      if (!onJoined) setJoined(true)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      if (isDuplicateMultisigMemberError(raw) && selectedPasskeyAccount) {
        const latest = await loadJoinPreview(token)
        const members = latest?.members ?? latest?.draft?.members ?? []
        const member = findDraftMemberForStoredAccount(members, selectedPasskeyAccount)
        if (member) {
          await sendToBackground({
            type: 'MULTISIG_ADD_PENDING_INVITE',
            payload: {
              token,
              joinedAt: Date.now(),
              walletName: walletNameFromJoinPreview(latest),
              draftId: latest?.draft?.id,
              multisigMemberId: member.id,
              passkeyCredentialId: selectedPasskeyAccount.passkeyCredentialId?.trim(),
              threshold: latest?.threshold ?? latest?.draft?.threshold,
              membersSnapshot: members,
              smartAccountAddress: latest?.draft?.smartAccountAddress,
            },
          })
          const sync = await apiSyncLocalMultisigAccounts({ activateFirstCreated: true })
          setWalletSynced(sync.created.length > 0 || sync.updated)
          await onAccountsSynced?.()
          onJoined?.()
          if (!onJoined) setJoined(true)
          return
        }
      }
      setJoinError(formatMultisigInviteError(raw))
    } finally {
      setJoinBusy(false)
    }
  }

  if (joined) {
    return (
      <div className="flex h-full min-h-[420px] w-full flex-col items-center justify-between gap-6 py-4">
        <div className="flex w-full flex-col items-center gap-3 text-center">
          <h1 className="text-[22px] font-medium leading-[1.32] tracking-[-0.44px] text-[#fcfcfc]">
            {walletSynced ? 'Wallet added' : "You're in"}
          </h1>
          <p className="max-w-[320px] text-[16px] leading-[1.4] tracking-[-0.32px] text-[#b3b3b3]">
            {walletSynced
              ? 'This multisig wallet is now in your Latch account list. Open the extension to view balances and proposals.'
              : 'Your passkey was added as a co-owner. The wallet will appear in Latch once the creator deploys it.'}
          </p>
        </div>
        <OnboardingPrimaryButton onClick={() => window.close()}>Close</OnboardingPrimaryButton>
      </div>
    )
  }

  return (
    <JoinMultisigScreen
      preview={preview}
      previewLoading={previewLoading}
      previewError={previewError}
      joinBusy={joinBusy}
      joinError={joinError}
      canReusePasskey={reusablePasskeyAccounts.length > 0}
      passkeyOptions={passkeyPickerOptions}
      selectedPasskeyAccountId={selectedPasskeyAccountId}
      onSelectPasskeyAccountId={setSelectedPasskeyAccountId}
      hideBack={hideBack}
      onBack={onBack ?? (() => window.close())}
      onJoinWithExistingPasskey={() => {
        if (!selectedPasskeyAccount) return
        const i = accounts.findIndex((a) => a.id === selectedPasskeyAccount.id)
        void completeJoin(() =>
          addStoredPasskeyToJoin({
            token,
            account: selectedPasskeyAccount,
            label: storedAccountLabel(selectedPasskeyAccount, i >= 0 ? i : 0),
          })
        )
      }}
      onJoinWithNewPasskey={() => {
        void completeJoin(() =>
          enrollNewPasskeyForJoin({
            token,
            label: 'Owner',
            accounts,
            surface,
          })
        )
      }}
    />
  )
}
