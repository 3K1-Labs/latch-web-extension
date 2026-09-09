import React, { useState } from 'react'

import closeIconUrl from 'url:../../../assets/home/icon-close.svg'
import aboutIconUrl from 'url:../../../assets/home/settings-about.svg'
import addressBookIconUrl from 'url:../../../assets/home/settings-address-book.svg'
import biometricsIconUrl from 'url:../../../assets/home/settings-biometrics.svg'
import helpIconUrl from 'url:../../../assets/home/settings-help.svg'
import logoutIconUrl from 'url:../../../assets/home/settings-logout.svg'
import multisigIconUrl from 'url:../../../assets/home/settings-multisig.svg'
import myAccountsIconUrl from 'url:../../../assets/home/settings-my-accounts.svg'
import myProfileIconUrl from 'url:../../../assets/home/settings-my-profile.svg'
import networkIconUrl from 'url:../../../assets/home/settings-network.svg'
import notificationsIconUrl from 'url:../../../assets/home/settings-notifications.svg'
import passwordIconUrl from 'url:../../../assets/home/settings-password.svg'
import permissionsIconUrl from 'url:../../../assets/home/settings-permissions.svg'
import recoveryPhraseIconUrl from 'url:../../../assets/home/settings-recovery-phrase.svg'
import signersIconUrl from 'url:../../../assets/home/settings-signers.svg'

import { AccountInformationScreen } from './settings/AccountInformationScreen'
import { AddressBookScreen } from './settings/AddressBookScreen'
import { ConfirmLogoutModal } from './settings/ConfirmLogoutModal'
import { NetworkSettingsScreen } from './settings/NetworkSettingsScreen'
import { PermissionsFlow } from './settings/PermissionsFlow'
import { ProfileCard } from './settings/ProfileCard'
import { SettingItem } from './settings/SettingItem'
import { SettingsSection } from './settings/SettingsSection'
import { SettingsToggle } from './settings/SettingsToggle'
import { ViewAccountsScreen, type ViewAccountItem } from './settings/ViewAccountsScreen'
import { PulsingDot } from '../components/PulsingDot'

import type { Network } from '@latch/types'

const rowIconClass = 'h-5 w-5 object-contain'

type SettingsView =
  | 'menu'
  | 'accountInformation'
  | 'viewAccounts'
  | 'addressBook'
  | 'permissions'
  | 'network'

export function SettingsScreen({
  surface,
  accountName,
  accountAddress,
  accounts,
  activeAccountId,
  biometricsEnabled,
  onChangeBiometricsEnabled,
  sidePanelEnabled,
  onChangeSidePanelEnabled,
  onSaveAccountName,
  onSelectAccount,
  onAccountsChanged,
  onCreateMultisig,
  onAddExistingMultisig,
  onDeleteAccount,
  onOpenMultisigWallets,
  onOpenMultisigProposals,
  pendingMultisigProposalCount,
  networkLabel,
  activeNetwork,
  onChangeNetwork,
  onClose,
  onLogout,
}: {
  surface: 'popup' | 'sidepanel'
  accountName: string
  accountAddress: string
  accounts: ViewAccountItem[]
  activeAccountId?: string
  biometricsEnabled: boolean
  onChangeBiometricsEnabled: (next: boolean) => void
  sidePanelEnabled?: boolean
  onChangeSidePanelEnabled?: (next: boolean) => void
  onSaveAccountName?: (walletName: string) => void
  onSelectAccount?: (accountId: string) => void
  onAccountsChanged?: () => void
  onCreateMultisig?: () => void
  onAddExistingMultisig?: () => void
  onDeleteAccount?: (accountId: string) => Promise<void>
  onOpenMultisigWallets?: () => void
  onOpenMultisigProposals?: () => void
  pendingMultisigProposalCount?: number
  networkLabel: string
  activeNetwork: Network
  onChangeNetwork: (network: Network) => Promise<void>
  onClose: () => void
  onLogout: () => void | Promise<void>
}) {
  const [view, setView] = useState<SettingsView>('menu')
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState<string | undefined>(undefined)

  const handleClose = () => {
    setView('menu')
    onClose()
  }

  async function confirmLogout() {
    setLogoutBusy(true)
    setLogoutError(undefined)
    try {
      await onLogout()
      setLogoutConfirmOpen(false)
    } catch (err) {
      setLogoutError(err instanceof Error ? err.message : 'Could not log out.')
    } finally {
      setLogoutBusy(false)
    }
  }

  if (view === 'network') {
    return (
      <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto rounded-bl-lg rounded-br-lg bg-[#1c1c1c] py-6 pl-6 pr-4">
        <NetworkSettingsScreen
          currentNetwork={activeNetwork}
          networkLabel={networkLabel}
          onBack={() => setView('menu')}
          onSelectNetwork={onChangeNetwork}
        />
      </div>
    )
  }

  if (view === 'addressBook') {
    return (
      <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto rounded-bl-lg rounded-br-lg bg-[#1c1c1c] py-6 pl-6 pr-4">
        <AddressBookScreen networkLabel={networkLabel} onBack={() => setView('menu')} />
      </div>
    )
  }

  if (view === 'permissions') {
    return (
      <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto rounded-bl-lg rounded-br-lg bg-[#1c1c1c] py-6 pl-6 pr-4">
        <PermissionsFlow onBackToSettings={() => setView('menu')} />
      </div>
    )
  }

  if (view === 'viewAccounts') {
    return (
      <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto rounded-bl-lg rounded-br-lg bg-[#1c1c1c] py-6 pl-6 pr-4">
        <ViewAccountsScreen
          surface={surface}
          accounts={accounts}
          activeAccountId={activeAccountId}
          onBack={() => setView('menu')}
          onAccountsChanged={() => onAccountsChanged?.()}
          onCreateMultisig={() => onCreateMultisig?.()}
          onAddExistingMultisig={() => onAddExistingMultisig?.()}
          onDeleteAccount={async (accountId) => {
            await onDeleteAccount?.(accountId)
            onAccountsChanged?.()
          }}
          onSave={(accountId) => {
            onSelectAccount?.(accountId)
            setView('menu')
          }}
        />
      </div>
    )
  }

  if (view === 'accountInformation') {
    return (
      <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto rounded-bl-lg rounded-br-lg bg-[#1c1c1c] py-6 pl-6 pr-4">
        <AccountInformationScreen
          accountName={accountName}
          accountAddress={accountAddress}
          onBack={() => setView('menu')}
          onSave={(walletName) => {
            onSaveAccountName?.(walletName)
            setView('menu')
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col items-end gap-2 overflow-y-auto rounded-bl-lg rounded-br-lg bg-[#1c1c1c] py-6 pl-6 pr-4">
      <button
        type="button"
        onClick={handleClose}
        className="relative size-5 shrink-0"
        aria-label="Close settings"
      >
        <img
          src={closeIconUrl}
          alt=""
          className="pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2"
        />
      </button>

      <div className="w-full min-h-0 flex-1">
        <ProfileCard
          name={accountName}
          address={accountAddress}
          onClick={() => setView('viewAccounts')}
        />

        <div className="mt-5 flex flex-col gap-5">
          <SettingsSection label="Account">
            <SettingItem
              icon={<img src={myProfileIconUrl} alt="" className={rowIconClass} />}
              label="My Profile"
            />
            <SettingItem
              icon={<img src={myAccountsIconUrl} alt="" className={rowIconClass} />}
              label="My Accounts"
              onClick={() => setView('viewAccounts')}
            />
            <SettingItem
              icon={<img src={addressBookIconUrl} alt="" className={rowIconClass} />}
              label="Address Book"
              onClick={() => setView('addressBook')}
            />
            <SettingItem
              icon={<img src={multisigIconUrl} alt="" className={rowIconClass} />}
              label="Multisig Wallets"
              onClick={() => onOpenMultisigWallets?.()}
            />
            {onOpenMultisigProposals ? (
              <SettingItem
                icon={<img src={multisigIconUrl} alt="" className={rowIconClass} />}
                label="Multisig Proposals"
                onClick={() => onOpenMultisigProposals()}
                rightElement={
                  pendingMultisigProposalCount && pendingMultisigProposalCount > 0 ? (
                    <PulsingDot pulsing className="ml-2" />
                  ) : undefined
                }
              />
            ) : null}
            <SettingItem
              icon={<img src={recoveryPhraseIconUrl} alt="" className={rowIconClass} />}
              label="Recovery Phrase"
            />
          </SettingsSection>

          <SettingsSection label="Security">
            <SettingItem
              icon={<img src={biometricsIconUrl} alt="" className={rowIconClass} />}
              label="Biometrics Authentication"
              showChevron={false}
              rightElement={
                <SettingsToggle
                  checked={biometricsEnabled}
                  onChange={onChangeBiometricsEnabled}
                  ariaLabel="Biometrics Authentication"
                />
              }
            />
            <SettingItem
              icon={<img src={passwordIconUrl} alt="" className={rowIconClass} />}
              label="Password"
            />
            <SettingItem
              icon={<img src={signersIconUrl} alt="" className={rowIconClass} />}
              label="Signers"
            />
            <SettingItem
              icon={<img src={permissionsIconUrl} alt="" className={rowIconClass} />}
              label="Permissions"
              onClick={() => setView('permissions')}
            />
          </SettingsSection>

          <SettingsSection label="Preferences">
            <SettingItem
              icon={<img src={networkIconUrl} alt="" className={rowIconClass} />}
              label="Network"
              onClick={() => setView('network')}
              rightElement={
                <span className="mr-2 truncate text-sm text-[#fcfcfc]/opacity-60">
                  {networkLabel}
                </span>
              }
            />
            <SettingItem
              icon={<img src={notificationsIconUrl} alt="" className={rowIconClass} />}
              label="Notifications"
            />
            {onChangeSidePanelEnabled ? (
              <SettingItem
                icon={<img src={networkIconUrl} alt="" className={rowIconClass} />}
                label="Side Panel"
                showChevron={false}
                rightElement={
                  <SettingsToggle
                    checked={sidePanelEnabled ?? false}
                    onChange={onChangeSidePanelEnabled}
                    ariaLabel="Enable side panel"
                  />
                }
              />
            ) : null}
          </SettingsSection>

          <SettingsSection label="Support">
            <SettingItem
              icon={<img src={helpIconUrl} alt="" className={rowIconClass} />}
              label="Help & Support"
            />
            <SettingItem
              icon={<img src={aboutIconUrl} alt="" className={rowIconClass} />}
              label="About Latch"
            />
          </SettingsSection>

          <SettingItem
            icon={<img src={logoutIconUrl} alt="" className={rowIconClass} />}
            label="Log Out"
            danger
            showChevron={false}
            onClick={() => {
              setLogoutError(undefined)
              setLogoutConfirmOpen(true)
            }}
          />
        </div>
      </div>

      <ConfirmLogoutModal
        isOpen={logoutConfirmOpen}
        busy={logoutBusy}
        error={logoutError}
        onCancel={() => {
          if (logoutBusy) return
          setLogoutConfirmOpen(false)
          setLogoutError(undefined)
        }}
        onConfirm={() => void confirmLogout()}
      />
    </div>
  )
}
