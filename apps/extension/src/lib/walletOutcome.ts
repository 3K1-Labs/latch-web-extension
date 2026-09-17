/**
 * Session-stored confirm outcomes so a destroyed action popup can restore
 * success/failure in the normal wallet UI (reopened popup or thin result window).
 */

export const PENDING_WALLET_OUTCOME_KEY = 'latch.pendingWalletOutcome' as const
export const PENDING_WALLET_OUTCOME_TTL_MS = 5 * 60 * 1000

export type WalletOutcomeKind =
  | 'swap'
  | 'send'
  | 'dapp'
  | 'multisigApprove'
  /** Adding or removing a backup passkey signer. */
  | 'accountSigners'

export type PendingWalletOutcome = {
  version: 1
  kind: WalletOutcomeKind
  status: 'in_progress' | 'success' | 'failure'
  createdAt: number
  updatedAt: number
  error?: string
  /** Opaque route payload (draft/quote/ids) — shape depends on `kind`. */
  payload?: Record<string, unknown>
}

export function isPendingWalletOutcomeFresh(
  pending: { createdAt?: number; updatedAt?: number } | null | undefined,
  nowMs = Date.now(),
  ttlMs = PENDING_WALLET_OUTCOME_TTL_MS
): boolean {
  if (!pending) return false
  const t = typeof pending.updatedAt === 'number' ? pending.updatedAt : pending.createdAt
  if (typeof t !== 'number') return false
  return nowMs - t <= ttlMs
}

export function isWalletResultOnlyUi(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('result') === '1') return true
  } catch {
    // ignore
  }
  return /[?#&]result=1(?:&|$)/.test(window.location.href)
}

export async function readPendingWalletOutcome(): Promise<PendingWalletOutcome | null> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return null
  const bag = await chrome.storage.session.get(PENDING_WALLET_OUTCOME_KEY)
  const raw = bag[PENDING_WALLET_OUTCOME_KEY] as PendingWalletOutcome | undefined
  if (!raw || raw.version !== 1) return null
  if (!isPendingWalletOutcomeFresh(raw)) {
    await chrome.storage.session.remove(PENDING_WALLET_OUTCOME_KEY)
    return null
  }
  return raw
}

export async function writePendingWalletOutcome(
  outcome: Omit<PendingWalletOutcome, 'version' | 'createdAt' | 'updatedAt'> & {
    createdAt?: number
  }
): Promise<PendingWalletOutcome> {
  const now = Date.now()
  const existing = await readPendingWalletOutcome()
  const next: PendingWalletOutcome = {
    version: 1,
    kind: outcome.kind,
    status: outcome.status,
    error: outcome.error,
    payload: outcome.payload ?? existing?.payload,
    createdAt: outcome.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
  }
  await chrome.storage.session.set({ [PENDING_WALLET_OUTCOME_KEY]: next })
  return next
}

export async function clearPendingWalletOutcome(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return
  await chrome.storage.session.remove(PENDING_WALLET_OUTCOME_KEY)
}

export async function consumePendingWalletOutcomeIf(
  kind: WalletOutcomeKind
): Promise<PendingWalletOutcome | null> {
  const pending = await readPendingWalletOutcome()
  if (!pending || pending.kind !== kind) return null
  if (pending.status === 'in_progress') return pending
  await clearPendingWalletOutcome()
  return pending
}

export async function finalizePendingWalletOutcome(args: {
  kind: WalletOutcomeKind
  status: 'success' | 'failure'
  error?: string
  payload?: Record<string, unknown>
}): Promise<PendingWalletOutcome> {
  return writePendingWalletOutcome({
    kind: args.kind,
    status: args.status,
    error: args.error,
    payload: args.payload,
  })
}
