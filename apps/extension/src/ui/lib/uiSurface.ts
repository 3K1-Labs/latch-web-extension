import type { Surface, UiSurfacePreference } from '../routing/routes'

export const UI_SURFACE_STORAGE_KEY = 'latch.uiSurface' as const

export async function openSidePanel() {
  if (!('sidePanel' in chrome)) return
  const win = await chrome.windows.getLastFocused()
  if (!win?.id) return
  await chrome.sidePanel.open({ windowId: win.id })
}

/**
 * Dismiss the popup or side panel after handing the user off to another surface
 * (e.g. onboarding tab). Best-effort; swallows errors.
 */
export async function closeWalletSurface(surface: Surface): Promise<void> {
  if (surface === 'sidepanel' && 'sidePanel' in chrome) {
    const closeFn = (
      chrome.sidePanel as typeof chrome.sidePanel & {
        close?: (options: { windowId: number }) => Promise<void>
      }
    ).close
    if (typeof closeFn === 'function') {
      try {
        const win = await chrome.windows.getCurrent()
        const windowId = win?.id ?? (await chrome.windows.getLastFocused())?.id
        if (windowId !== undefined) {
          await closeFn.call(chrome.sidePanel, { windowId })
          return
        }
      } catch {
        // fall through to window.close
      }
    }
  }

  try {
    window.close()
  } catch {
    // ignore
  }
}

export async function setDefaultSurface(pref: UiSurfacePreference) {
  await chrome.storage.local.set({ [UI_SURFACE_STORAGE_KEY]: pref })
}
