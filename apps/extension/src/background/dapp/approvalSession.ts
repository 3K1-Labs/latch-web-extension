import type { ExternalSignResult, PendingDappRequest, SignTransactionResponse } from '@latch/types'

import { BackendError } from '../api/client'
import type { ExternalSignDecision } from '../externalSign/orchestrator'
import { isDappOriginDisconnected } from '../storage'
import {
  clearAllDappRequests,
  findLiveDappRequest,
  listLiveDappRequests,
  resolveDappRequest,
  resetDappRequestStateForTests,
  upsertDappRequest,
  type DappRequestRecord,
} from './requestState'

type PendingResolver = (result: ExternalSignDecision) => void
/** Same-generation fast-path only — session storage is authoritative. */
export const pendingDappResolvers = new Map<string, PendingResolver>()

/** Durable approval windows Latch opened — keyed for focus/reuse and cleanup. */
const approvalPopupWindowIds = new Set<number>()
const approvalWindowByOrigin = new Map<string, number>()

/**
 * In-flight connect prompts coalesced per origin+kind. Without this, a dApp that
 * retries getPublicKey (common right after disconnect) opens a new window each time.
 */
const inflightApprovals = new Map<
  string,
  { requestId: string; promise: Promise<ExternalSignDecision> }
>()

/**
 * After a dismissed Grant Access window, briefly refuse to open another prompt
 * for that origin. Explicit `disconnect()` uses a persisted sticky flag instead
 * (see `isDappOriginDisconnected`) so retries cannot spam after SW suspend.
 */
const grantAccessSuppressedUntil = new Map<string, number>()
const GRANT_ACCESS_COOLDOWN_MS = 2_500

export function mergePermissions<T extends string>(base: T[], add: T): T[] {
  return base.includes(add) ? base : [...base, add]
}

function approvalKey(origin: string, kind: PendingDappRequest['kind']): string {
  return `${origin}::${kind}`
}

export function suppressGrantAccessPrompt(origin: string, ms = GRANT_ACCESS_COOLDOWN_MS): void {
  grantAccessSuppressedUntil.set(origin, Date.now() + ms)
}

export function isGrantAccessSuppressed(origin: string): boolean {
  const until = grantAccessSuppressedUntil.get(origin)
  if (until == null) return false
  if (Date.now() >= until) {
    grantAccessSuppressedUntil.delete(origin)
    return false
  }
  return true
}

/**
 * Fail closed before opening Grant Access: sticky disconnect (authoritative) or
 * short in-memory cooldown after a dismissed prompt.
 */
export async function assertDappConnectPromptAllowed(origin: string): Promise<void> {
  if ((await isDappOriginDisconnected(origin)) || isGrantAccessSuppressed(origin)) {
    throw new BackendError('Site not connected — call getPublicKey to reconnect', {
      status: 403,
      code: 'not_connected',
    })
  }
}

function decisionFromRecord(record: DappRequestRecord): ExternalSignDecision {
  if (record.status === 'approved') {
    return {
      approved: true,
      signedXdr: record.signedXdr,
      txHash: record.txHash,
      signedAuthEntry: record.signedAuthEntry,
      signedTxXdr: record.signedTxXdr,
    }
  }
  return {
    approved: false,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
  }
}

function wakeResolver(requestId: string, decision: ExternalSignDecision): void {
  const resolver = pendingDappResolvers.get(requestId)
  pendingDappResolvers.delete(requestId)
  resolver?.(decision)
}

/**
 * Register an optional same-generation waiter. Authoritative completion is via
 * session storage + poll (or resolveDappRequestDecision).
 */
export function waitForExternalSignDecision(requestId: string): Promise<ExternalSignDecision> {
  return new Promise((resolve) => {
    pendingDappResolvers.set(requestId, resolve)
  })
}

/**
 * Persist a terminal decision, wake any same-generation waiter, and return the
 * stored row. Idempotent when already terminal.
 */
export async function resolveDappRequestDecision(
  req: Parameters<typeof resolveDappRequest>[0]
): Promise<DappRequestRecord | null> {
  const { record } = await resolveDappRequest(req)
  if (!record) {
    wakeResolver(req.requestId, {
      approved: req.approved,
      errorMessage: req.errorMessage,
      errorCode: req.errorCode,
      signedXdr: req.signedXdr,
      txHash: req.txHash,
      signedAuthEntry: req.signedAuthEntry,
      signedTxXdr: req.signedTxXdr,
    })
    return null
  }
  wakeResolver(req.requestId, decisionFromRecord(record))
  return record
}

async function rejectAllPendingDappRequests(decision: ExternalSignDecision = { approved: false }) {
  const live = await listLiveDappRequests()
  for (const pending of live) {
    await resolveDappRequestDecision({
      requestId: pending.id,
      approved: decision.approved,
      errorCode: decision.errorCode,
      errorMessage: decision.errorMessage,
      signedXdr: decision.signedXdr,
      txHash: decision.txHash,
      signedAuthEntry: decision.signedAuthEntry,
      signedTxXdr: decision.signedTxXdr,
    })
  }
  inflightApprovals.clear()
  // Also clear any leftover session rows (including terminal) so the queue is empty.
  await clearAllDappRequests()
}

async function closeApprovalWindowsForOrigin(origin: string): Promise<void> {
  const windowId = approvalWindowByOrigin.get(origin)
  if (windowId == null) return
  approvalWindowByOrigin.delete(origin)
  approvalPopupWindowIds.delete(windowId)
  try {
    await chrome.windows.remove(windowId)
  } catch {
    // Already closed.
  }
}

/** Close a tracked durable approval window after approve / reject / sign settles. */
export async function closeApprovalWindowForOrigin(origin: string): Promise<void> {
  await closeApprovalWindowsForOrigin(origin)
}

/**
 * Disconnect drops only the calling origin's waiters — other sites keep theirs.
 * Also closes any Grant Access window for that origin. Sticky reconnect block is
 * set by the DAPP_DISCONNECT handler via markDappOriginDisconnected.
 */
export async function rejectPendingDappRequestsForOrigin(origin: string): Promise<void> {
  await closeApprovalWindowsForOrigin(origin)

  const stored = await listLiveDappRequests()
  for (const pending of stored) {
    if (pending.origin !== origin) continue
    const key = approvalKey(pending.origin, pending.kind)
    inflightApprovals.delete(key)
    await resolveDappRequestDecision({
      requestId: pending.id,
      approved: false,
      errorCode: 'not_connected',
      errorMessage: 'Site disconnected from Latch',
    })
  }
}

function rejectPendingOnWindowClose(windowId: number) {
  if (!approvalPopupWindowIds.has(windowId)) return
  approvalPopupWindowIds.delete(windowId)

  let closedOrigin: string | undefined
  for (const [origin, id] of approvalWindowByOrigin.entries()) {
    if (id === windowId) {
      closedOrigin = origin
      approvalWindowByOrigin.delete(origin)
      break
    }
  }
  if (closedOrigin) suppressGrantAccessPrompt(closedOrigin)

  void rejectAllPendingDappRequests({ approved: false })
}

export function initDappApprovalListeners() {
  if (chrome.windows?.onRemoved) {
    chrome.windows.onRemoved.addListener((windowId) => {
      rejectPendingOnWindowClose(windowId)
    })
  }
}

/**
 * Prefer the toolbar action popup. Fall back to a durable 360×600 window only when
 * openPopup fails (no user gesture, sidepanel mode, etc.).
 *
 * Anti-spam (coalesce + cooldown) prevents retry loops from stacking windows; we no
 * longer skip openPopup entirely — that left every flow in a durable window.
 */
export async function openApprovalPopup(origin?: string): Promise<number | undefined> {
  if (origin) {
    const existingId = approvalWindowByOrigin.get(origin)
    if (existingId != null) {
      try {
        await chrome.windows.update(existingId, { focused: true })
        return existingId
      } catch {
        approvalWindowByOrigin.delete(origin)
        approvalPopupWindowIds.delete(existingId)
      }
    }
  }

  try {
    if ('action' in chrome && typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup()
      // Toolbar popup — not tracked; Chrome owns its lifetime.
      return undefined
    }
  } catch {
    // Fall through to durable window.
  }

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?durable=1'),
      type: 'popup',
      width: 360,
      height: 600,
      focused: true,
    })
    if (win.id !== undefined) {
      approvalPopupWindowIds.add(win.id)
      if (origin) approvalWindowByOrigin.set(origin, win.id)
      return win.id
    }
  } catch (err) {
    console.error('[latch:background] openApprovalPopup failed', err)
  }
  return undefined
}

function registerInflight(
  origin: string,
  kind: PendingDappRequest['kind'],
  requestId: string,
  promise: Promise<ExternalSignDecision>
): void {
  if (kind !== 'getPublicKey') return
  const key = approvalKey(origin, kind)
  inflightApprovals.set(key, { requestId, promise })
  void promise.finally(() => {
    const current = inflightApprovals.get(key)
    if (current?.requestId === requestId) inflightApprovals.delete(key)
  })
}

/**
 * Enqueue an approval request and open the UI without waiting for the user.
 * Content scripts poll `DAPP_POLL_REQUEST_RESULT` for the terminal result.
 * Returns a same-generation promise for callers that still await in-process.
 */
export async function enqueueDappApproval(args: {
  origin: string
  kind: PendingDappRequest['kind']
  signRequest?: PendingDappRequest['signRequest']
  prepared?: PendingDappRequest['prepared']
  localReview?: PendingDappRequest['localReview']
  source?: PendingDappRequest['source']
}): Promise<{ requestId: string; decisionPromise: Promise<ExternalSignDecision> }> {
  if (args.kind === 'getPublicKey') {
    await assertDappConnectPromptAllowed(args.origin)

    const existing = await findLiveDappRequest({ origin: args.origin, kind: args.kind })
    if (existing) {
      const key = approvalKey(args.origin, args.kind)
      const inflight = inflightApprovals.get(key)
      if (inflight && inflight.requestId === existing.id) {
        await openApprovalPopup(args.origin)
        return { requestId: existing.id, decisionPromise: inflight.promise }
      }
      const promise = waitForExternalSignDecision(existing.id)
      registerInflight(args.origin, args.kind, existing.id, promise)
      await openApprovalPopup(args.origin)
      return { requestId: existing.id, decisionPromise: promise }
    }

    const key = approvalKey(args.origin, args.kind)
    const mem = inflightApprovals.get(key)
    if (mem) {
      await openApprovalPopup(args.origin)
      return { requestId: mem.requestId, decisionPromise: mem.promise }
    }
  }

  const requestId = crypto.randomUUID()
  const pending: PendingDappRequest = {
    id: requestId,
    origin: args.origin,
    kind: args.kind,
    createdAt: Date.now(),
    status: 'awaiting_user',
    signRequest: args.signRequest,
    prepared: args.prepared,
    localReview: args.localReview,
    source: args.source,
  }

  const decisionPromise = waitForExternalSignDecision(requestId)
  registerInflight(args.origin, args.kind, requestId, decisionPromise)

  await upsertDappRequest(pending, 'awaiting_user')
  await openApprovalPopup(args.origin)
  return { requestId, decisionPromise }
}

/**
 * Enqueue + await a decision (used by openSignRequest connect and any
 * same-SW awaiters). Prefer enqueueDappApproval + poll for provider methods.
 */
export async function requireDappApproval(args: {
  origin: string
  kind: PendingDappRequest['kind']
  signRequest?: PendingDappRequest['signRequest']
  prepared?: PendingDappRequest['prepared']
  source?: PendingDappRequest['source']
}): Promise<ExternalSignDecision> {
  const { decisionPromise } = await enqueueDappApproval(args)
  return await decisionPromise
}

/** Test helper — clear cooldown / inflight maps between cases. */
export async function resetDappApprovalSessionForTests(): Promise<void> {
  pendingDappResolvers.clear()
  inflightApprovals.clear()
  grantAccessSuppressedUntil.clear()
  approvalPopupWindowIds.clear()
  approvalWindowByOrigin.clear()
  resetDappRequestStateForTests()
  await clearAllDappRequests()
}

export function mapExternalSignResultToProviderResponse(
  result: ExternalSignResult
): SignTransactionResponse {
  if (result.status === 'rejected') {
    throw new BackendError(result.message ?? 'User rejected', {
      status: 403,
      code: result.code ?? 'user_rejected',
    })
  }
  if (result.status === 'error') {
    throw new BackendError(result.message ?? 'Signing failed', {
      status: 400,
      code: result.code ?? 'error',
    })
  }
  return {
    txHash: result.txHash,
    signedAuthEntry: result.signedAuthEntry,
    signedTxXdr: result.signedTxXdr,
    signedXdr: result.signedTxXdr ?? result.txHash,
  }
}
