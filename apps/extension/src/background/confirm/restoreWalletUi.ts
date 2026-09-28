/**
 * Bring the toolbar popup back after a background confirm job, so the stored
 * outcome renders there. Never opens a separate window: if Chrome refuses
 * `openPopup`, the outcome waits in session storage for the next popup open.
 */

async function toolbarPopupIsOpen(): Promise<boolean> {
  if (typeof chrome.runtime?.getContexts !== 'function') return false
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['POPUP' as chrome.runtime.ContextType],
    })
    return contexts.length > 0
  } catch {
    return false
  }
}

async function lastFocusedNormalWindowId(): Promise<number | undefined> {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    return win?.id
  } catch {
    return undefined
  }
}

export async function restoreWalletUiAfterConfirm(): Promise<void> {
  if (await toolbarPopupIsOpen()) return
  if (typeof chrome.action?.openPopup !== 'function') return

  const windowId = await lastFocusedNormalWindowId()
  await chrome.action.openPopup(windowId !== undefined ? { windowId } : undefined)
}
