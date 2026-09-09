import React, { useCallback, useEffect, useState } from 'react'

import type {
  MultisigAccount,
  MultisigPendingInvite,
  MultisigProposal,
  MultisigProposalDetail,
  StoredAccount,
} from '@latch/types'

import { sendToBackground } from '../lib/backgroundClient'
import {
  clearMultisigJoinQueryFromLocation,
  parseMultisigJoinTokenFromLocation,
} from '../lib/multisigDeepLink'
import {
  apiAddExistingMultisigAccount,
  apiSyncLocalMultisigAccounts,
  apiCreateLocalMultisigAccount,
  apiListMultisigAccounts,
} from '../lib/multisigFlow'
import { AddExistingMultisigScreen } from '../screens/multisig/AddExistingMultisigScreen'
import { MultisigJoinFlow } from './MultisigJoinFlow'
import { MultisigCreateWizard } from './MultisigCreateWizard'
import { MultisigProposalsViews } from './MultisigProposalsViews'
import { MultisigWalletsScreen } from '../screens/multisig/MultisigWalletsScreen'

export type MultisigRoute =
  | 'createMultisig'
  | 'addMultisigOwners'
  | 'multisigThreshold'
  | 'multisigReviewDeploy'
  | 'multisigSuccess'
  | 'multisigDeployFailure'
  | 'addExistingMultisig'
  | 'joinMultisig'
  | 'multisigProposals'
  | 'multisigProposalDetail'
  | 'multisigWallets'

const MULTISIG_CREATE_ROUTES = new Set<string>([
  'createMultisig',
  'addMultisigOwners',
  'multisigThreshold',
  'multisigReviewDeploy',
  'multisigSuccess',
  'multisigDeployFailure',
])

const MULTISIG_PROPOSAL_ROUTES = new Set<string>(['multisigProposals', 'multisigProposalDetail'])

export function useMultisigJoinTokenOnMount(onJoin: (token: string) => void) {
  useEffect(() => {
    const token = parseMultisigJoinTokenFromLocation()
    if (!token) return
    onJoin(token)
    clearMultisigJoinQueryFromLocation()
  }, [onJoin])
}

export function MultisigRouteViews({
  route,
  surface,
  activeAccount,
  accounts,
  externalJoinToken,
  onRefreshAccounts,
  onSetRoute,
  onSetActiveAccountId,
  externalProposalId,
}: {
  route: MultisigRoute | string
  surface: 'popup' | 'sidepanel'
  activeAccount: StoredAccount | undefined
  accounts: StoredAccount[]
  externalJoinToken?: string | null
  externalProposalId?: string | null
  onRefreshAccounts: () => Promise<void>
  onSetRoute: (route: string) => void
  onSetActiveAccountId: (id: string) => void
}) {
  const [internalJoinToken, setInternalJoinToken] = useState<string | null>(null)
  const joinToken = externalJoinToken ?? internalJoinToken

  const [deployedAccounts, setDeployedAccounts] = useState<MultisigAccount[]>([])
  const [pendingInvites, setPendingInvites] = useState<MultisigPendingInvite[]>([])
  const [joinCode, setJoinCode] = useState('')
  const [joinCodeError, setJoinCodeError] = useState<string | null>(null)

  const [addExistingAddress, setAddExistingAddress] = useState('')
  const [addExistingLabel, setAddExistingLabel] = useState('')
  const [addExistingError, setAddExistingError] = useState<string | null>(null)
  const [addExistingBusy, setAddExistingBusy] = useState(false)

  async function submitAddExistingMultisig() {
    const smartAccountAddress = addExistingAddress.trim()
    if (!smartAccountAddress || addExistingBusy) return
    setAddExistingBusy(true)
    setAddExistingError(null)
    try {
      const result = await apiAddExistingMultisigAccount({
        smartAccountAddress,
        label: addExistingLabel.trim() || undefined,
      })
      await onRefreshAccounts()
      onSetActiveAccountId(result.account.id)
      setAddExistingAddress('')
      setAddExistingLabel('')
      onSetRoute('home')
    } catch (err) {
      setAddExistingError(
        err instanceof Error ? err.message : 'Could not add that MultiSig wallet.'
      )
    } finally {
      setAddExistingBusy(false)
    }
  }

  const loadMultisigHub = useCallback(async () => {
    try {
      await apiSyncLocalMultisigAccounts()
      await onRefreshAccounts()
      const [accountsRes, invitesRes] = await Promise.all([
        apiListMultisigAccounts(),
        sendToBackground<undefined, { invites: MultisigPendingInvite[] }>({
          type: 'MULTISIG_GET_PENDING_INVITES',
          payload: undefined,
        }),
      ])
      setDeployedAccounts(accountsRes.accounts ?? [])
      if (invitesRes.ok && invitesRes.data) setPendingInvites(invitesRes.data.invites)
    } catch {
      // ignore
    }
  }, [onRefreshAccounts])

  useEffect(() => {
    if (route === 'multisigWallets') void loadMultisigHub()
  }, [route, loadMultisigHub])

  if (MULTISIG_CREATE_ROUTES.has(route)) {
    return (
      <MultisigCreateWizard
        route={route}
        surface={surface}
        activeAccount={activeAccount}
        accounts={accounts}
        onRefreshAccounts={onRefreshAccounts}
        onSetRoute={onSetRoute}
        onSetActiveAccountId={onSetActiveAccountId}
      />
    )
  }

  if (MULTISIG_PROPOSAL_ROUTES.has(route)) {
    return (
      <MultisigProposalsViews
        route={route}
        surface={surface}
        activeAccount={activeAccount}
        accounts={accounts}
        externalProposalId={externalProposalId}
        onSetRoute={onSetRoute}
      />
    )
  }

  if (route === 'joinMultisig' && joinToken) {
    return (
      <MultisigJoinFlow
        token={joinToken}
        accounts={accounts}
        surface={surface}
        onAccountsSynced={onRefreshAccounts}
        onJoined={() => onSetRoute('multisigWallets')}
        onBack={() => onSetRoute('home')}
      />
    )
  }

  if (route === 'addExistingMultisig') {
    return (
      <AddExistingMultisigScreen
        address={addExistingAddress}
        label={addExistingLabel}
        error={addExistingError}
        busy={addExistingBusy}
        onAddressChange={(next) => {
          setAddExistingAddress(next)
          setAddExistingError(null)
        }}
        onLabelChange={setAddExistingLabel}
        onBack={() => {
          setAddExistingAddress('')
          setAddExistingLabel('')
          setAddExistingError(null)
          onSetRoute('home')
        }}
        onSubmit={() => void submitAddExistingMultisig()}
      />
    )
  }

  if (route === 'multisigWallets') {
    return (
      <MultisigWalletsScreen
        deployed={deployedAccounts}
        pendingInvites={pendingInvites}
        joinCode={joinCode}
        joinCodeError={joinCodeError}
        onBack={() => onSetRoute('home')}
        onOpenDeployed={async (account) => {
          const local = accounts.find((a) => a.smartAccountAddress === account.smartAccountAddress)
          if (local) {
            onSetActiveAccountId(local.id)
            await onRefreshAccounts()
          } else {
            const created = await apiCreateLocalMultisigAccount({
              smartAccountAddress: account.smartAccountAddress,
              label: account.label,
              multisigThreshold: account.threshold,
              multisigMemberId: account.memberId,
              multisigBackendAccountId: account.id,
            })
            onSetActiveAccountId(created.account.id)
            await onRefreshAccounts()
          }
          onSetRoute('home')
        }}
        onOpenPendingInvite={(invite) => {
          setInternalJoinToken(invite.token)
          onSetRoute('joinMultisig')
        }}
        onJoinCodeChange={setJoinCode}
        onSubmitJoinCode={() => {
          const token = joinCode.trim()
          if (!token) {
            setJoinCodeError('Enter an invite token')
            return
          }
          setJoinCodeError(null)
          setInternalJoinToken(token)
          onSetRoute('joinMultisig')
        }}
        onRemovePendingInvite={(token) => {
          void sendToBackground<{ token: string }, { invites: MultisigPendingInvite[] }>({
            type: 'MULTISIG_REMOVE_PENDING_INVITE',
            payload: { token },
          }).then((res) => {
            if (res.ok && res.data?.invites) setPendingInvites(res.data.invites)
          })
        }}
      />
    )
  }

  return null
}

export function multisigPendingApprovalCount(
  proposals: MultisigProposal[],
  memberId: string | undefined
): number {
  if (!memberId) return 0
  return proposals.filter(
    (p) =>
      p.status !== 'executed' &&
      !(p as MultisigProposalDetail).approvals?.some((a) => a.memberId === memberId)
  ).length
}
