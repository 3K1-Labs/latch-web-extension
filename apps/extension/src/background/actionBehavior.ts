/**
 * Chrome action / side-panel / onboarding-tab behavior for the background SW.
 * Registers onInstalled, onStartup, and storage.onChanged listeners on import.
 */

import type { GetSetupStateResponse, SetSetupStateRequest, SetupState } from '@latch/types'

import { broadcastActiveAccountChanged, broadcastNetworkChanged } from './dappProviderEvents'
import { getActiveNetwork } from './network/config'
import {
  getAccounts,
  getSetupStateForNetwork,
  setSetupStateForNetwork,
  storageKeys,
} from './storage'

export const STORAGE_KEYS = {
  setupState: 'latch.setupState',
  accountPublicKey: 'latch.accountPublicKey',
  uiSurface: 'latch.uiSurface',
} as const

type UiSurfacePreference = 'popup' | 'sidepanel'

export async function getSetupState(): Promise<GetSetupStateResponse> {
  const network = await getActiveNetwork()
  const setupState = ((await getSetupStateForNetwork(network)) as SetupState | undefined) ?? 'new'
  const result = await chrome.storage.local.get([STORAGE_KEYS.accountPublicKey])

  return {
    setupState,
    accountPublicKey: result[STORAGE_KEYS.accountPublicKey] as string | undefined,
  }
}

export async function setSetupState(req: SetSetupStateRequest): Promise<void> {
  const network = await getActiveNetwork()
  await setSetupStateForNetwork(network, req.setupState, req.accountPublicKey)
}

const ONBOARDING_TAB_PATH = 'tabs/onboarding.html'
const ACCOUNTS_BY_NETWORK_KEY = storageKeys().accountsByNetwork
const ACTIVE_ID_BY_NETWORK_KEY = storageKeys().activeAccountIdByNetwork
const SETUP_BY_NETWORK_KEY = storageKeys().setupStateByNetwork
const LEGACY_ACCOUNTS_KEY = storageKeys().accounts
const LEGACY_ACTIVE_ID_KEY = storageKeys().activeAccountId
const LEGACY_SETUP_KEY = storageKeys().setupState
const NETWORK_STORAGE_KEY = 'latch.network'

/**
 * Stored accounts are the source of truth for whether onboarding should show.
 * `latch.setupState` can be missing on older installs or after partial logout flows.
 */
export async function ensureSetupStateMatchesAccounts(): Promise<void> {
  const { accounts, activeAccountId } = await getAccounts()
  if (accounts.length === 0) return

  const { setupState } = await getSetupState()
  if (setupState === 'has_account') return

  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0]
  const accountPublicKey =
    active?.smartAccountAddress?.trim() || active?.gAddress?.trim() || undefined

  await setSetupState({ setupState: 'has_account', accountPublicKey })
}

async function needsOnboardingFlow(): Promise<boolean> {
  const { accounts } = await getAccounts()
  return accounts.length === 0
}

export async function openOnboardingTab(): Promise<void> {
  const url = chrome.runtime.getURL(ONBOARDING_TAB_PATH)

  try {
    const existing = await chrome.tabs.query({ url: `${url}*` })
    const tab = existing.find((t) => t.url?.startsWith(url))
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { active: true })
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true })
      }
      return
    }
  } catch (err) {
    console.warn('[latch:background] openOnboardingTab query failed; creating tab', err)
  }

  await chrome.tabs.create({ url })
}

async function applyUiSurfacePreference(pref: UiSurfacePreference) {
  // Side panel API is Chrome-only; Plasmo will map to Firefox sidebar_action where relevant,
  // but we still need to guard the runtime API surface.
  const hasSidePanel = 'sidePanel' in chrome

  try {
    if (pref === 'sidepanel') {
      // Let action-click open the side panel.
      await chrome.action.setPopup({ popup: '' })

      if (hasSidePanel) {
        await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true })
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      }
    } else {
      await chrome.action.setPopup({ popup: 'popup.html' })
      if (hasSidePanel) {
        await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true })
        // Critical: do NOT open sidepanel on action click in popup mode.
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
      }
    }
  } catch (err) {
    console.error('[latch:background] applyUiSurfacePreference failed', err)
  }
}

function handleOnboardingActionClick(): void {
  void (async () => {
    if (await needsOnboardingFlow()) {
      await openOnboardingTab()
    }
  })()
}

let onboardingActionClickListening = false

/**
 * Chrome toggles the side panel from the toolbar when `openPanelOnActionClick` is true.
 * A registered `action.onClicked` listener prevents that native toggle, so only attach
 * it while onboarding (no accounts) still needs the full-screen tab flow.
 */
function syncOnboardingActionClickListener(needsOnboarding: boolean): void {
  if (needsOnboarding && !onboardingActionClickListening) {
    chrome.action.onClicked.addListener(handleOnboardingActionClick)
    onboardingActionClickListening = true
    return
  }
  if (!needsOnboarding && onboardingActionClickListening) {
    chrome.action.onClicked.removeListener(handleOnboardingActionClick)
    onboardingActionClickListening = false
  }
}

/** Popup / side panel when set up; full-screen onboarding tab before `has_account`. */
export async function applyActionClickBehavior(): Promise<void> {
  try {
    const needsOnboarding = await needsOnboardingFlow()
    syncOnboardingActionClickListener(needsOnboarding)

    if (needsOnboarding) {
      await chrome.action.setPopup({ popup: '' })
      if ('sidePanel' in chrome) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
      }
      return
    }

    const res = await chrome.storage.local.get([STORAGE_KEYS.uiSurface])
    const pref: UiSurfacePreference =
      res[STORAGE_KEYS.uiSurface] === 'sidepanel' ? 'sidepanel' : 'popup'
    await applyUiSurfacePreference(pref)
  } catch (err) {
    console.error('[latch:background] applyActionClickBehavior failed', err)
  }
}

async function initExtensionActionBehavior() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.uiSurface])
  const v = res[STORAGE_KEYS.uiSurface]

  if (v !== 'popup' && v !== 'sidepanel') {
    await chrome.storage.local.set({
      [STORAGE_KEYS.uiSurface]: 'popup' satisfies UiSurfacePreference,
    })
  }

  await ensureSetupStateMatchesAccounts()
  await applyActionClickBehavior()
}

chrome.runtime.onInstalled.addListener((details) => {
  // Always default to popup on first install, and reset to popup on update so users
  // don't get stuck in sidepanel mode without realizing why action-click changed.
  if (details.reason === 'install' || details.reason === 'update') {
    void chrome.storage.local
      .set({ [STORAGE_KEYS.uiSurface]: 'popup' satisfies UiSurfacePreference })
      .then(async () => {
        await ensureSetupStateMatchesAccounts()
        await applyActionClickBehavior()
      })
    return
  }

  void initExtensionActionBehavior()
})

chrome.runtime.onStartup.addListener(() => {
  void initExtensionActionBehavior()
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  const changed = Object.keys(changes)
  const touchesAccounts = changed.some(
    (key) =>
      key === LEGACY_SETUP_KEY ||
      key === SETUP_BY_NETWORK_KEY ||
      key === LEGACY_ACCOUNTS_KEY ||
      key === ACCOUNTS_BY_NETWORK_KEY ||
      key.endsWith('accounts.byNetwork') ||
      key.endsWith('setupState.byNetwork') ||
      key === 'latch.developerMode'
  )
  const touchesActive = changed.some(
    (key) =>
      key === LEGACY_ACTIVE_ID_KEY ||
      key === ACTIVE_ID_BY_NETWORK_KEY ||
      key === LEGACY_ACCOUNTS_KEY ||
      key === ACCOUNTS_BY_NETWORK_KEY ||
      key.endsWith('accounts.byNetwork') ||
      key.endsWith('activeAccountId.byNetwork') ||
      key === 'latch.developerMode'
  )
  if (changes[STORAGE_KEYS.uiSurface] || touchesAccounts || changes[NETWORK_STORAGE_KEY]) {
    void ensureSetupStateMatchesAccounts().then(() => applyActionClickBehavior())
  }
  if (touchesActive) {
    void broadcastActiveAccountChanged()
  }
  if (changes[NETWORK_STORAGE_KEY] || changes['latch.developerMode']) {
    void broadcastNetworkChanged()
  }
})

void initExtensionActionBehavior()
