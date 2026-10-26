/**
 * Builds the user reviewed, held by the background so the signer never trusts tx bytes from the
 * popup. Keyed by a hash of the request that produced the build, so Confirm can only ever sign a
 * build made from exactly the draft/quote on screen. Session storage only: it is in-memory,
 * cleared when the browser closes, and never written to `chrome.storage.local`.
 */

import { reviewedBuildStillValid } from '../../ui/lib/reviewedBuild'

export const REVIEWED_BUILDS_KEY = 'latch.reviewedBuilds' as const
const MAX_ENTRIES = 8

/** The request a swap prepare is made from; the handler and the executor must agree on it. */
export function reviewedSwapBody(accountId: string, quote: unknown): unknown {
  return { accountId, quote }
}

export type ReviewedBuildKind = 'send' | 'swap'

type Entry = { kind: ReviewedBuildKind; build: unknown; builtAt: number }
type Store = Record<string, Entry>

/** JSON with sorted keys and no `undefined`, so equal requests hash equally. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${parts.join(',')}}`
}

export async function reviewedBuildKey(kind: ReviewedBuildKind, body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}:${stableStringify(body)}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function readStore(): Promise<Store> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return {}
  const bag = await chrome.storage.session.get(REVIEWED_BUILDS_KEY)
  return (bag[REVIEWED_BUILDS_KEY] as Store | undefined) ?? {}
}

async function writeStore(store: Store): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return
  await chrome.storage.session.set({ [REVIEWED_BUILDS_KEY]: store })
}

/** Reads and writes are read-modify-write: run them one at a time. */
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/**
 * Remember the build made from `body`. `builtAt` is when the request started. Best effort: if
 * storage fails the user still gets their estimate, and Confirm asks them to review again.
 *
 * Callers need not await it: the write is queued on the same serial queue as `takeReviewedBuild`
 * synchronously, so a later take (Confirm) always runs after it.
 */
export function saveReviewedBuild(
  kind: ReviewedBuildKind,
  body: unknown,
  build: unknown,
  builtAt = Date.now()
): Promise<void> {
  return serialized(async () => {
    const key = await reviewedBuildKey(kind, body)
    const store = await readStore()
    delete store[key]
    store[key] = { kind, build, builtAt }
    const live = Object.entries(store).filter(([, e]) => reviewedBuildStillValid(e))
    await writeStore(Object.fromEntries(live.slice(-MAX_ENTRIES)))
  }).catch((e) => {
    console.warn('[latch:background] could not hold the reviewed build', e)
  })
}

/**
 * The still-valid build made from `body`, or null. A build is signed once, so it is removed.
 */
export function takeReviewedBuild<T>(kind: ReviewedBuildKind, body: unknown): Promise<T | null> {
  return serialized(async () => {
    const key = await reviewedBuildKey(kind, body)
    const store = await readStore()
    const entry = store[key]
    if (!entry) return null
    delete store[key]
    await writeStore(store)
    return entry.kind === kind && reviewedBuildStillValid(entry) ? (entry.build as T) : null
  })
}
