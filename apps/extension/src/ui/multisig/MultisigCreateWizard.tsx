import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { MultisigDraftMember, MultisigPredictResponse, StoredAccount } from '@latch/types'

import { sendToBackground } from '../lib/backgroundClient'
import { buildMultisigInviteUrl } from '../lib/multisigDeepLink'
import {
  apiAddDraftMember,
  apiSyncLocalMultisigAccounts,
  buildSeedDraftMemberFromGAddress,
  apiCreateLocalMultisigAccount,
  apiCreateMultisigDraft,
  apiDeployDraft,
  apiGetActiveDraft,
  apiJoinPreview,
  apiListMultisigAccounts,
  apiPredictDraft,
  apiRemoveDraftMember,
  apiUpdateDraftThreshold,
  extractDraftId,
  extractInviteToken,
  memberCountFromDraft,
} from '../lib/multisigFlow'
import {
  enrollExistingPasskeyForDraft,
  enrollNewPasskeyForDraft,
  listReusablePasskeyAccounts,
} from '../lib/multisigPasskey'
import { findDraftMemberForStoredAccount } from '../lib/multisigJoinHelpers'
import { multisigDraftMembersEqual } from '../lib/multisigMembers'
import { storedAccountLabel } from '../lib/storedAccountLabel'
import { toMultisigPasskeyOptions } from './MultisigPasskeyPicker'
import { AddMultisigOwnersScreen } from '../screens/multisig/AddMultisigOwnersScreen'
import { CreateMultisigScreen } from '../screens/multisig/CreateMultisigScreen'
import { MultisigReviewDeployScreen } from '../screens/multisig/MultisigReviewDeployScreen'
import { MultisigDeployFailureScreen } from '../screens/multisig/MultisigDeployFailureScreen'
import { MultisigDeploySuccessScreen } from '../screens/multisig/MultisigDeploySuccessScreen'
import { MultisigThresholdScreen } from '../screens/multisig/MultisigThresholdScreen'

const MULTISIG_OWNERS_POLL_MS = 3000

type WizardState = {
  walletName: string
  purpose: string
  draftId: string
  inviteToken: string
  threshold: number
  smartAccountAddress: string
  creatorPasskeyMemberId?: string
}

export function MultisigCreateWizard({
  route,
  surface,
  activeAccount,
  accounts,
  onRefreshAccounts,
  onSetRoute,
  onSetActiveAccountId,
}: {
  route: string
  surface: 'popup' | 'sidepanel'
  activeAccount: StoredAccount | undefined
  accounts: StoredAccount[]
  onRefreshAccounts: () => Promise<void>
  onSetRoute: (route: string) => void
  onSetActiveAccountId: (id: string) => void
}) {
  const [wizard, setWizard] = useState<WizardState | null>(null)
  const [draftMembers, setDraftMembers] = useState<MultisigDraftMember[]>([])
  const [passkeyAdding, setPasskeyAdding] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  const [ownerAddError, setOwnerAddError] = useState<string | null>(null)
  const [ownerAddBusy, setOwnerAddBusy] = useState(false)
  const [ownersRefreshBusy, setOwnersRefreshBusy] = useState(false)
  const [createDraftError, setCreateDraftError] = useState<string | null>(null)
  const [predicted, setPredicted] = useState<MultisigPredictResponse | null>(null)
  const [predictLoading, setPredictLoading] = useState(false)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [deployBusy, setDeployBusy] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)

  const inviteUrl = wizard ? buildMultisigInviteUrl(wizard.inviteToken) : ''
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

  const applyDraftPasskeyEnrollment = useCallback(
    (draft: { members?: MultisigDraftMember[] }, credentialId: string) => {
      const members = draft.members ?? []
      setDraftMembers(members)
      const added = members.find((m) => m.credentialId === credentialId)
      if (added?.id) {
        setWizard((w) => (w ? { ...w, creatorPasskeyMemberId: added.id } : w))
      }
    },
    []
  )

  const handleSelectPasskeyAccountId = useCallback((accountId: string) => {
    setSelectedPasskeyAccountId(accountId)
  }, [])

  const addExistingPasskeyOwner = useCallback(async () => {
    if (!wizard?.draftId || wizard.creatorPasskeyMemberId || !selectedPasskeyAccount) return
    setPasskeyAdding(true)
    setPasskeyError(null)
    try {
      const draft = await enrollExistingPasskeyForDraft({
        draftId: wizard.draftId,
        account: selectedPasskeyAccount,
        label: wizard.walletName,
        surface,
      })
      applyDraftPasskeyEnrollment(draft, selectedPasskeyAccount.passkeyCredentialId!.trim())
    } catch (e) {
      setPasskeyError(e instanceof Error ? e.message : String(e))
    } finally {
      setPasskeyAdding(false)
    }
  }, [wizard, selectedPasskeyAccount, surface, applyDraftPasskeyEnrollment])

  const addNewPasskeyOwner = useCallback(async () => {
    if (!wizard?.draftId || wizard.creatorPasskeyMemberId) return
    setPasskeyAdding(true)
    setPasskeyError(null)
    try {
      const { draft, credentialId } = await enrollNewPasskeyForDraft({
        draftId: wizard.draftId,
        label: wizard.walletName,
        accountLabel: wizard.walletName,
        accounts,
        surface,
      })
      applyDraftPasskeyEnrollment(draft, credentialId)
    } catch (e) {
      setPasskeyError(e instanceof Error ? e.message : String(e))
    } finally {
      setPasskeyAdding(false)
    }
  }, [wizard, surface, applyDraftPasskeyEnrollment, accounts])

  const refreshDraftMembers = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!wizard?.draftId) return
      if (!opts?.silent) setOwnersRefreshBusy(true)
      try {
        let members: MultisigDraftMember[] = []
        if (wizard.inviteToken) {
          const preview = await apiJoinPreview(wizard.inviteToken)
          members = preview.members ?? preview.draft?.members ?? []
        } else {
          const data = await apiGetActiveDraft()
          members = data.draft?.members ?? []
        }
        setDraftMembers((prev) => (multisigDraftMembersEqual(prev, members) ? prev : members))
        setWizard((w) => {
          if (!w) return w
          let creatorPasskeyMemberId = w.creatorPasskeyMemberId
          if (creatorPasskeyMemberId && !members.some((m) => m.id === creatorPasskeyMemberId)) {
            creatorPasskeyMemberId = undefined
          }
          if (!creatorPasskeyMemberId && selectedPasskeyAccount) {
            const added = findDraftMemberForStoredAccount(members, selectedPasskeyAccount)
            if (added?.id) creatorPasskeyMemberId = added.id
          }
          if (creatorPasskeyMemberId === w.creatorPasskeyMemberId) return w
          return { ...w, creatorPasskeyMemberId }
        })
      } catch {
        // ignore — refresh is best-effort
      } finally {
        if (!opts?.silent) setOwnersRefreshBusy(false)
      }
    },
    [wizard?.draftId, wizard?.inviteToken, selectedPasskeyAccount]
  )

  const passkeyAddingRef = useRef(passkeyAdding)
  passkeyAddingRef.current = passkeyAdding
  const ownerAddBusyRef = useRef(ownerAddBusy)
  ownerAddBusyRef.current = ownerAddBusy

  useEffect(() => {
    if (route !== 'addMultisigOwners' || !wizard?.draftId) return

    const poll = () => {
      if (passkeyAddingRef.current || ownerAddBusyRef.current) return
      void refreshDraftMembers({ silent: true })
    }

    const id = window.setInterval(poll, MULTISIG_OWNERS_POLL_MS)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [route, wizard?.draftId, refreshDraftMembers])

  useEffect(() => {
    if (route !== 'addMultisigOwners' || !wizard?.draftId) return
    void refreshDraftMembers()
  }, [route, wizard?.draftId, refreshDraftMembers])

  useEffect(() => {
    if (route !== 'multisigReviewDeploy' || !wizard?.draftId) return
    setPredictLoading(true)
    setPredictError(null)
    void apiPredictDraft(wizard.draftId)
      .then(setPredicted)
      .catch((e) => setPredictError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPredictLoading(false))
  }, [route, wizard?.draftId])

  async function handleCreateMultisigContinue(walletName: string, purpose: string) {
    setCreateDraftError(null)
    try {
      const data = await apiCreateMultisigDraft()
      const draftId = extractDraftId(data)
      const inviteToken = extractInviteToken(data)
      setWizard({
        walletName,
        purpose,
        draftId,
        inviteToken,
        threshold: 2,
        smartAccountAddress: '',
      })
      setDraftMembers(data.draft?.members ?? [])
      await sendToBackground({
        type: 'MULTISIG_SET_DRAFT_META',
        payload: { draftId, inviteToken, walletName, purpose },
      })
      onSetRoute('addMultisigOwners')
    } catch (e) {
      setCreateDraftError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleAddOwnerByAddress(ownerName: string, address: string) {
    if (!wizard?.draftId) return
    setOwnerAddBusy(true)
    setOwnerAddError(null)
    try {
      const draft = await apiAddDraftMember(
        wizard.draftId,
        buildSeedDraftMemberFromGAddress(ownerName, address)
      )
      setDraftMembers(draft.members ?? [])
    } catch (e) {
      setOwnerAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setOwnerAddBusy(false)
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!wizard?.draftId) return
    try {
      const draft = await apiRemoveDraftMember(wizard.draftId, memberId)
      setDraftMembers(draft.members ?? [])
      if (wizard.creatorPasskeyMemberId === memberId) {
        setWizard((w) => (w ? { ...w, creatorPasskeyMemberId: undefined } : w))
      }
    } catch (e) {
      setOwnerAddError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeploy() {
    if (!wizard?.draftId) return
    setDeployBusy(true)
    setDeployError(null)
    try {
      const result = await apiDeployDraft(wizard.draftId)
      const smartAccountAddress = result.smartAccountAddress
      const threshold = wizard.threshold
      let memberId = wizard.creatorPasskeyMemberId ?? activeAccount?.multisigMemberId
      try {
        const listed = await apiListMultisigAccounts()
        const match = listed.accounts?.find((a) => a.smartAccountAddress === smartAccountAddress)
        memberId = match?.memberId ?? memberId
      } catch {
        // ignore
      }
      const local = await apiCreateLocalMultisigAccount({
        smartAccountAddress,
        label: wizard.walletName,
        multisigThreshold: threshold,
        multisigMemberId: memberId,
        multisigBackendAccountId: undefined,
      })
      await apiSyncLocalMultisigAccounts()
      await sendToBackground({ type: 'MULTISIG_CLEAR_DRAFT_META', payload: undefined })
      setWizard((w) => (w ? { ...w, smartAccountAddress } : w))
      onSetActiveAccountId(local.account.id)
      await onRefreshAccounts()
      onSetRoute('multisigSuccess')
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : String(e))
      onSetRoute('multisigDeployFailure')
    } finally {
      setDeployBusy(false)
    }
  }

  if (route === 'createMultisig') {
    return (
      <CreateMultisigScreen
        error={createDraftError}
        onBack={() => onSetRoute('home')}
        onContinue={(walletName, purpose) => void handleCreateMultisigContinue(walletName, purpose)}
      />
    )
  }

  if (route === 'addMultisigOwners' && wizard) {
    return (
      <AddMultisigOwnersScreen
        walletName={wizard.walletName}
        members={draftMembers}
        inviteUrl={inviteUrl}
        inviteToken={wizard.inviteToken}
        youMemberId={wizard.creatorPasskeyMemberId}
        passkeyAdding={passkeyAdding}
        passkeyError={passkeyError}
        passkeyOptions={passkeyPickerOptions}
        selectedPasskeyAccountId={selectedPasskeyAccountId}
        onSelectPasskeyAccountId={handleSelectPasskeyAccountId}
        canReusePasskey={reusablePasskeyAccounts.length > 0}
        addBusy={ownerAddBusy}
        addError={ownerAddError}
        refreshBusy={ownersRefreshBusy}
        onBack={() => onSetRoute('createMultisig')}
        onAddSelectedPasskeyOwner={() => void addExistingPasskeyOwner()}
        onAddNewPasskeyOwner={() => void addNewPasskeyOwner()}
        onAddOwnerByAddress={(name, addr) => void handleAddOwnerByAddress(name, addr)}
        onRemoveMember={(id) => void handleRemoveMember(id)}
        onRefreshMembers={() => void refreshDraftMembers()}
        ownersLiveUpdating
        onContinue={() => onSetRoute('multisigThreshold')}
      />
    )
  }

  if (route === 'multisigThreshold' && wizard) {
    return (
      <MultisigThresholdScreen
        memberCount={memberCountFromDraft({ members: draftMembers })}
        initialThreshold={wizard.threshold}
        onBack={() => onSetRoute('addMultisigOwners')}
        onContinue={(threshold) => {
          void apiUpdateDraftThreshold(wizard.draftId, threshold).then(() => {
            setWizard((w) => (w ? { ...w, threshold } : w))
            onSetRoute('multisigReviewDeploy')
          })
        }}
      />
    )
  }

  if (route === 'multisigReviewDeploy' && wizard) {
    return (
      <MultisigReviewDeployScreen
        walletName={wizard.walletName}
        threshold={wizard.threshold}
        memberCount={memberCountFromDraft({ members: draftMembers })}
        predicted={predicted}
        predictLoading={predictLoading}
        predictError={predictError}
        deployBusy={deployBusy}
        deployError={deployError}
        onBack={() => onSetRoute('multisigThreshold')}
        onDeploy={() => void handleDeploy()}
      />
    )
  }

  if (route === 'multisigSuccess' && wizard) {
    return (
      <MultisigDeploySuccessScreen
        smartAccountAddress={wizard.smartAccountAddress}
        onCopyAddress={() => {
          const addr = wizard.smartAccountAddress?.trim()
          if (!addr) return
          void navigator.clipboard.writeText(addr)
        }}
        onShareAddress={() => {
          const addr = wizard.smartAccountAddress?.trim()
          if (!addr) return
          const share = (
            navigator as unknown as { share?: (data: { text: string }) => Promise<void> }
          ).share
          if (share) {
            void share({ text: addr }).catch(() => {
              void navigator.clipboard.writeText(addr)
            })
          } else {
            void navigator.clipboard.writeText(addr)
          }
        }}
        onOpenReceiveQr={() => {
          // Reuse the existing Receive QR flow; it uses the active account address.
          setWizard(null)
          onSetRoute('receive')
        }}
        onGoToWallet={() => {
          setWizard(null)
          onSetRoute('home')
        }}
      />
    )
  }

  if (route === 'multisigDeployFailure' && wizard) {
    return (
      <MultisigDeployFailureScreen
        onTryAgain={() => {
          onSetRoute('multisigReviewDeploy')
        }}
      />
    )
  }

  return null
}
