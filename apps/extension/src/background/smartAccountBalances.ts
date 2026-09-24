import { loadSmartAccountPortfolioRows, STELLAR_SAC_DISPLAY_DECIMALS } from '@latch/stellar'

import type { GetSmartAccountBalancesResponse, SmartAccountBalanceRow } from '@latch/types'

import { resolveIconDataUrlForAsset } from './assetIcons'
import { getKnownSacProbes } from './knownSacProbes'
import {
  getActiveNetwork,
  horizonUrlFor,
  networkPassphraseFor,
  sorobanRpcUrlFor,
} from './network/config'
import { getAccounts } from './storage'
import { getMarketPrices } from './marketPrices'
import { computeBalanceUsd, computeTotalBalanceUsd } from './tokenPrices'

type Snapshot = {
  updatedAtMs: number
  data: GetSmartAccountBalancesResponse
}

const FRESH_TTL_MS = 60_000
const MAX_STALE_MS = 5 * 60_000

let memoryCacheByAccountId: Map<string, Snapshot> | null = null
const inflightByAccountId: Map<string, Promise<GetSmartAccountBalancesResponse>> = new Map()

export function clearSmartAccountBalancesMemoryCache(): void {
  memoryCacheByAccountId = null
  inflightByAccountId.clear()
}

function snapshotFreshEnough(s: Snapshot, now: number): boolean {
  return now - s.updatedAtMs < FRESH_TTL_MS
}

function snapshotUsableAsStaleFallback(s: Snapshot, now: number): boolean {
  return now - s.updatedAtMs < MAX_STALE_MS
}

async function storageKeyForAccount(accountId: string): Promise<string> {
  // Include network in cache key because the same account id could exist across testnet/mainnet.
  const network = await getActiveNetwork()
  return `latch.smartAccountBalances.${network}.${accountId}.v1`
}

async function readPersistedSnapshot(accountId: string): Promise<Snapshot | null> {
  try {
    const key = await storageKeyForAccount(accountId)
    const r = await chrome.storage.local.get([key])
    const raw = r[key]
    if (!raw || typeof raw !== 'object') return null
    const s = raw as Partial<Snapshot>
    if (typeof s.updatedAtMs !== 'number') return null
    if (!s.data || typeof s.data !== 'object') return null
    return { updatedAtMs: s.updatedAtMs, data: s.data as GetSmartAccountBalancesResponse }
  } catch {
    return null
  }
}

async function writePersistedSnapshot(accountId: string, snapshot: Snapshot): Promise<void> {
  try {
    const key = await storageKeyForAccount(accountId)
    await chrome.storage.local.set({ [key]: snapshot })
  } catch {
    // best-effort only
  }
}

function isTimeoutLikeError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return e.name === 'AbortError' || e.message.toLowerCase().includes('timed out')
}

function isNetworkLikeError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('load failed') ||
    msg.includes('disconnected')
  )
}

async function computeBalancesOnce(accountId: string): Promise<GetSmartAccountBalancesResponse> {
  const { accounts } = await getAccounts()
  const acc = accounts.find((a) => a.id === accountId)
  const c = acc?.smartAccountAddress?.trim()
  if (!c) return { rows: [] }

  const g = acc?.gAddress?.trim()
  const network = await getActiveNetwork()
  const rpcUrl = sorobanRpcUrlFor(network)
  const horizonUrl = horizonUrlFor(network)
  const passphrase = networkPassphraseFor(network)

  // Hard cap for portfolio load (Horizon + Soroban RPC). Without this, cold starts can hang forever.
  const portfolioSignal = AbortSignal.timeout(12_000)
  const knownProbes = await getKnownSacProbes(accountId)
  const core = await loadSmartAccountPortfolioRows({
    rpcUrl,
    networkPassphrase: passphrase,
    network,
    cAddress: c,
    gAddress: g,
    horizonUrl,
    additionalProbes: knownProbes,
    signal: portfolioSignal,
  })

  // Prices are strictly optional. Never fail balances due to market API timeouts.
  let pricesByCodeUpper: Record<string, { priceUsd: number; change24h: number }> = {}
  try {
    const res = await getMarketPrices(core.map((r) => r.code))
    pricesByCodeUpper = res.pricesByCodeUpper
  } catch {
    pricesByCodeUpper = {}
  }

  // Icons are best-effort. Never fail balances due to icon resolution.
  const iconResultsSettled = await Promise.allSettled(
    core.map(async (row) => {
      if (row.code.toUpperCase() === 'XLM' && !row.issuer) return null
      return await resolveIconDataUrlForAsset({
        network,
        horizonUrl,
        code: row.code,
        issuer: row.issuer,
        sacContractId: row.sacContractId,
      })
    })
  )

  const rows: SmartAccountBalanceRow[] = core.map((row, i) => {
    const priceUsd = pricesByCodeUpper[row.code.toUpperCase()]?.priceUsd
    const balanceUsd = computeBalanceUsd(row.amount, priceUsd)
    const iconSettled = iconResultsSettled[i]
    const iconUrl =
      row.code.toUpperCase() === 'XLM' && !row.issuer
        ? null
        : iconSettled?.status === 'fulfilled'
          ? (iconSettled.value ?? null)
          : null
    return {
      code: row.code,
      issuer: row.issuer,
      sacContractId: row.sacContractId,
      ...(row.code.toUpperCase() === 'XLM' && !row.issuer ? { assetId: 'native' as const } : {}),
      amount: row.amount,
      decimals: STELLAR_SAC_DISPLAY_DECIMALS,
      iconUrl,
      balanceUsd: balanceUsd ?? undefined,
    }
  })

  const totalBalanceUsd =
    computeTotalBalanceUsd(
      rows,
      Object.fromEntries(
        Object.entries(pricesByCodeUpper).map(([k, v]) => [k, v.priceUsd] as const)
      )
    ) ?? undefined

  return { rows, totalBalanceUsd }
}

async function computeBalancesWithRetry(
  accountId: string
): Promise<GetSmartAccountBalancesResponse> {
  const backoffMs = [0, 400, 1_200, 2_500]
  let lastErr: unknown = null
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]))
    }
    try {
      return await computeBalancesOnce(accountId)
    } catch (e) {
      lastErr = e
      // Retry only for the common cold-start/transient cases.
      if (!(isTimeoutLikeError(e) || isNetworkLikeError(e))) throw e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function revalidateInBackground(accountId: string): void {
  if (inflightByAccountId.has(accountId)) return

  const p = computeBalancesWithRetry(accountId)
    .then(async (data) => {
      const snapshot: Snapshot = { updatedAtMs: Date.now(), data }
      memoryCacheByAccountId!.set(accountId, snapshot)
      await writePersistedSnapshot(accountId, snapshot)
      return data
    })
    .finally(() => {
      inflightByAccountId.delete(accountId)
    })

  inflightByAccountId.set(accountId, p)
  // Background revalidate must not reject unhandled; UI already has cached balances.
  void p.catch((e) => {
    console.error('[latch:balances] revalidate', e)
  })
}

export async function runGetSmartAccountBalances(
  accountId: string
): Promise<GetSmartAccountBalancesResponse> {
  const now = Date.now()
  if (!memoryCacheByAccountId) {
    memoryCacheByAccountId = new Map()
  }

  const mem = memoryCacheByAccountId.get(accountId)
  if (mem && snapshotFreshEnough(mem, now)) return mem.data

  // Warm start: load persisted cache into memory (only once per account per cold SW start).
  if (!mem) {
    const persisted = await readPersistedSnapshot(accountId)
    if (persisted) {
      memoryCacheByAccountId.set(accountId, persisted)
      if (snapshotFreshEnough(persisted, now)) return persisted.data
      if (snapshotUsableAsStaleFallback(persisted, now)) {
        revalidateInBackground(accountId)
        return persisted.data
      }
    }
  } else if (snapshotUsableAsStaleFallback(mem, now)) {
    revalidateInBackground(accountId)
    return mem.data
  }

  const existing = inflightByAccountId.get(accountId)
  if (existing) return await existing

  const p = computeBalancesWithRetry(accountId)
    .then(async (data) => {
      const snapshot: Snapshot = { updatedAtMs: Date.now(), data }
      memoryCacheByAccountId!.set(accountId, snapshot)
      await writePersistedSnapshot(accountId, snapshot)
      return data
    })
    .finally(() => {
      inflightByAccountId.delete(accountId)
    })

  inflightByAccountId.set(accountId, p)

  try {
    return await p
  } catch (e) {
    const fallback = memoryCacheByAccountId.get(accountId)
    if (fallback && snapshotUsableAsStaleFallback(fallback, Date.now())) {
      return fallback.data
    }
    throw e
  }
}
