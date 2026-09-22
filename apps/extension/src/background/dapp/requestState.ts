/**
 * Restart-safe dApp request state machine.
 *
 * Pending connect/sign approvals live in chrome.storage.session so they survive
 * MV3 service-worker restarts. In-memory resolvers are a same-generation
 * fast-path only — never the sole place a decision can live.
 */

import type { DappRequestStatus, PendingDappRequest, ResolvePendingDappRequest } from '@latch/types'

export const DAPP_REQUESTS_SESSION_KEY = 'latch.dappRequests' as const
/** Legacy queue from pre-state-machine builds — cleared on first session read. */
export const LEGACY_PENDING_DAPP_REQUESTS_LOCAL_KEY = 'latch.pendingDappRequests' as const

export const DAPP_REQUEST_TTL_MS = 5 * 60 * 1000

const LIVE_STATUSES: ReadonlySet<DappRequestStatus> = new Set(['awaiting_user', 'signing'])
const TERMINAL_STATUSES: ReadonlySet<DappRequestStatus> = new Set([
  'approved',
  'rejected',
  'expired',
])

export type DappRequestRecord = PendingDappRequest & {
  status: DappRequestStatus
  updatedAt: number
}

type StoreBag = Record<string, DappRequestRecord>

let legacyLocalCleared = false

async function clearLegacyLocalPending(): Promise<void> {
  try {
    await chrome.storage.local.remove([LEGACY_PENDING_DAPP_REQUESTS_LOCAL_KEY])
  } catch {
    // ignore
  }
  legacyLocalCleared = true
}

async function clearLegacyLocalPendingOnce(): Promise<void> {
  if (legacyLocalCleared) return
  await clearLegacyLocalPending()
}

function nowMs(): number {
  return Date.now()
}

function normalizeStatus(req: PendingDappRequest): DappRequestStatus {
  return req.status ?? 'awaiting_user'
}

function toRecord(req: PendingDappRequest, status?: DappRequestStatus): DappRequestRecord {
  const ts = nowMs()
  return {
    ...req,
    status: status ?? normalizeStatus(req),
    createdAt: typeof req.createdAt === 'number' ? req.createdAt : ts,
    updatedAt: typeof req.updatedAt === 'number' ? req.updatedAt : ts,
  }
}

async function readStore(): Promise<StoreBag> {
  await clearLegacyLocalPendingOnce()
  const bag = await chrome.storage.session.get(DAPP_REQUESTS_SESSION_KEY)
  const raw = bag[DAPP_REQUESTS_SESSION_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as StoreBag
}

async function writeStore(store: StoreBag): Promise<void> {
  await chrome.storage.session.set({ [DAPP_REQUESTS_SESSION_KEY]: store })
}

export function isLiveDappRequestStatus(status: DappRequestStatus | undefined): boolean {
  return LIVE_STATUSES.has(status ?? 'awaiting_user')
}

export function isTerminalDappRequestStatus(status: DappRequestStatus | undefined): boolean {
  return TERMINAL_STATUSES.has(status ?? 'awaiting_user')
}

export function isDappRequestFresh(
  req: { createdAt?: number; updatedAt?: number } | null | undefined,
  now = nowMs(),
  ttlMs = DAPP_REQUEST_TTL_MS
): boolean {
  if (!req) return false
  const t = typeof req.updatedAt === 'number' ? req.updatedAt : req.createdAt
  if (typeof t !== 'number') return false
  return now - t <= ttlMs
}

/** Expire stale live rows; drop aged terminal rows. Returns the pruned store. */
export async function expireStaleDappRequests(now = nowMs()): Promise<StoreBag> {
  const store = await readStore()
  let changed = false
  const next: StoreBag = {}

  for (const [id, row] of Object.entries(store)) {
    if (!row || typeof row !== 'object') {
      changed = true
      continue
    }
    const status = normalizeStatus(row)
    if (isLiveDappRequestStatus(status) && !isDappRequestFresh(row, now)) {
      next[id] = {
        ...row,
        status: 'expired',
        updatedAt: now,
        errorCode: row.errorCode ?? 'expired',
        errorMessage: row.errorMessage ?? 'Request expired',
      }
      changed = true
      continue
    }
    if (isTerminalDappRequestStatus(status) && !isDappRequestFresh(row, now)) {
      changed = true
      continue
    }
    next[id] = { ...row, status }
  }

  if (changed) await writeStore(next)
  return next
}

export async function getDappRequest(requestId: string): Promise<DappRequestRecord | null> {
  const store = await expireStaleDappRequests()
  return store[requestId] ?? null
}

export async function upsertDappRequest(
  req: PendingDappRequest,
  status: DappRequestStatus = 'awaiting_user'
): Promise<DappRequestRecord> {
  const store = await expireStaleDappRequests()
  const existing = store[req.id]
  const record = toRecord(
    {
      ...existing,
      ...req,
      updatedAt: nowMs(),
    },
    status
  )
  store[req.id] = record
  await writeStore(store)
  return record
}

/**
 * Idempotent terminal transition. If already terminal with the same outcome,
 * returns the existing row. If already terminal with a different outcome,
 * leaves the existing row unchanged (first writer wins).
 */
export async function resolveDappRequest(
  req: ResolvePendingDappRequest
): Promise<{ record: DappRequestRecord | null; changed: boolean }> {
  const store = await expireStaleDappRequests()
  const existing = store[req.requestId]
  if (!existing) return { record: null, changed: false }

  const nextStatus: DappRequestStatus = req.approved ? 'approved' : 'rejected'
  const currentStatus = normalizeStatus(existing)

  if (isTerminalDappRequestStatus(currentStatus)) {
    // First writer wins — duplicate resolves are a no-op success.
    return { record: existing, changed: false }
  }

  const record: DappRequestRecord = {
    ...existing,
    status: nextStatus,
    updatedAt: nowMs(),
    errorMessage: req.errorMessage,
    errorCode: req.errorCode,
    signedXdr: req.signedXdr,
    txHash: req.txHash,
    signedAuthEntry: req.signedAuthEntry,
    signedTxXdr: req.signedTxXdr,
  }
  store[req.requestId] = record
  await writeStore(store)
  return { record, changed: true }
}

export async function markDappRequestSigning(requestId: string): Promise<DappRequestRecord | null> {
  const store = await expireStaleDappRequests()
  const existing = store[requestId]
  if (!existing) return null
  if (!isLiveDappRequestStatus(normalizeStatus(existing))) return existing
  const record: DappRequestRecord = {
    ...existing,
    status: 'signing',
    updatedAt: nowMs(),
  }
  store[requestId] = record
  await writeStore(store)
  return record
}

/** UI-facing live queue (awaiting_user + signing). */
export async function listLiveDappRequests(): Promise<DappRequestRecord[]> {
  const store = await expireStaleDappRequests()
  return Object.values(store)
    .filter((r) => isLiveDappRequestStatus(normalizeStatus(r)))
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function findLiveDappRequest(args: {
  origin: string
  kind: PendingDappRequest['kind']
}): Promise<DappRequestRecord | null> {
  const live = await listLiveDappRequests()
  return live.find((r) => r.origin === args.origin && r.kind === args.kind) ?? null
}

export async function removeDappRequest(requestId: string): Promise<void> {
  const store = await readStore()
  if (!(requestId in store)) return
  delete store[requestId]
  await writeStore(store)
}

export async function clearAllDappRequests(): Promise<void> {
  await chrome.storage.session.remove([DAPP_REQUESTS_SESSION_KEY])
  await clearLegacyLocalPending()
}

/** Test helper — reset module latch so legacy clear runs again. */
export function resetDappRequestStateForTests(): void {
  legacyLocalCleared = false
}
