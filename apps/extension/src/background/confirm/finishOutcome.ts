import { finalizePendingWalletOutcome, type WalletOutcomeKind } from '../../lib/walletOutcome'
import { restoreWalletUiAfterConfirm } from './restoreWalletUi'

/**
 * Record a background job's result and bring the wallet UI back.
 *
 * Only the toolbar popup needs this: it is destroyed when a passkey ceremony
 * window takes focus, so the job outlives the surface that started it. The
 * side panel survives and reads the response directly.
 */
export async function finishOutcome(args: {
  surface?: 'popup' | 'sidepanel'
  kind: WalletOutcomeKind
  status: 'success' | 'failure'
  error?: string
  payload?: Record<string, unknown>
}): Promise<void> {
  if (args.surface !== 'popup') return
  await finalizePendingWalletOutcome({
    kind: args.kind,
    status: args.status,
    error: args.error,
    payload: args.payload,
  })
  try {
    await restoreWalletUiAfterConfirm()
  } catch (e) {
    console.warn('[latch:background] restoreWalletUiAfterConfirm failed', e)
  }
}
