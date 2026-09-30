/**
 * Smart-account activity feed: merge Horizon (G-address + bundler) with Soroban
 * SAC transfer events. Horizon cannot query C-addresses via /accounts/{C}/operations
 * (HTTP 400), so passkey wallets rely on bundler ops + wildcard getEvents.
 *
 * Depth limits (same as mobile — not archival history):
 * - Horizon G: last 50 ops
 * - Horizon bundler: last 200 ops
 * - SAC getEvents: ~6k ledgers (~hours on mainnet); shrinks on RPC processing limits
 */

import { Address, Asset, scValToNative, xdr } from '@stellar/stellar-sdk'

import { curatedPortfolioProbes, type StellarNetwork } from './curatedAssets'
import { parseHorizonAccountJson } from './migrationBalances'
import { formatSacRawToHuman, STELLAR_SAC_DISPLAY_DECIMALS } from './sacBalance'
import {
  fetchHorizonAccountJson,
  portfolioProbesFromHorizonAccount,
  type PortfolioTokenProbe,
} from './smartAccountPortfolio'

export interface SmartAccountPayment {
  id: string
  transactionHash: string
  type: string
  /** Derived after classifyPaymentTxTypes */
  txType?: 'send' | 'receive' | 'swap' | 'bridge' | 'unknown'
  from: string
  to: string
  amount: string
  assetType: string
  assetCode?: string
  createdAt: string
}

export type SacAssetInfo = { code: string; assetType: string }

/** Largest reach that clears mainnet processing-limit for wildcard-topic queries. */
const SAC_EVENTS_REACH_LEDGERS = 6_000
const SAC_EVENTS_MIN_REACH_LEDGERS = 500
const MAX_SAC_PROBE_CONTRACTS = 15

function mergeAbortSignals(
  timeoutMs: number,
  signal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onParentAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onParentAbort)
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onParentAbort)
    },
  }
}

async function horizonGet(url: string, signal?: AbortSignal): Promise<unknown> {
  const { signal: merged, cleanup } = mergeAbortSignals(12_000, signal)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: merged,
    })
    if (!res.ok) {
      throw new Error(`Horizon HTTP ${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      throw new Error('Horizon response was not JSON')
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Horizon')) throw e
    throw new Error('Horizon request failed')
  } finally {
    cleanup()
  }
}

async function sorobanRpc(
  rpcUrl: string,
  method: string,
  params: object,
  signal?: AbortSignal
): Promise<unknown> {
  const { signal: merged, cleanup } = mergeAbortSignals(15_000, signal)
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: merged,
    })
    if (!res.ok) {
      throw new Error(`Soroban RPC ${method}: HTTP ${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      throw new Error(`Soroban RPC ${method}: unparseable response`)
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Soroban RPC')) throw e
    throw new Error(`Soroban RPC ${method}: request failed`)
  } finally {
    cleanup()
  }
}

/** Normalize contract/account strkeys for comparison. */
export function stellarAddressEquals(a: string, b: string): boolean {
  try {
    return Address.fromString(a).toString() === Address.fromString(b).toString()
  } catch {
    return a === b
  }
}

function scValB64(val: xdr.ScVal): string {
  return val.toXDR('base64')
}

/** Build contractId → asset info for labeling SAC transfer events. */
export function buildSacAssetInfoMap(params: {
  networkPassphrase: string
  network?: StellarNetwork
  additionalProbes?: PortfolioTokenProbe[]
}): Map<string, SacAssetInfo> {
  const map = new Map<string, SacAssetInfo>()
  try {
    map.set(Asset.native().contractId(params.networkPassphrase), {
      code: 'XLM',
      assetType: 'native',
    })
  } catch {
    // ignore
  }

  const network = params.network ?? 'testnet'
  for (const p of curatedPortfolioProbes(params.networkPassphrase, network)) {
    map.set(p.sacContractId, {
      code: p.code,
      assetType: p.code.toUpperCase() === 'XLM' && !p.issuer ? 'native' : 'credit_alphanum4',
    })
  }

  for (const p of params.additionalProbes ?? []) {
    if (!p.sacContractId) continue
    map.set(p.sacContractId, {
      code: p.code,
      assetType: p.code.toUpperCase() === 'XLM' && !p.issuer ? 'native' : 'credit_alphanum4',
    })
  }

  return map
}

/** @deprecated Prefer buildSacAssetInfoMap — kept for callers that need probe lists. */
export async function buildSacProbesForHistory(params: {
  horizonUrl: string
  networkPassphrase: string
  gAddress?: string | null
  signal?: AbortSignal
}): Promise<PortfolioTokenProbe[]> {
  const probes: PortfolioTokenProbe[] = [
    { code: 'XLM', sacContractId: Asset.native().contractId(params.networkPassphrase) },
  ]

  const g = params.gAddress?.trim()
  if (g) {
    try {
      const json = await fetchHorizonAccountJson(params.horizonUrl, g, params.signal)
      const record = parseHorizonAccountJson(json)
      if (record) {
        const fromG = portfolioProbesFromHorizonAccount(record, params.networkPassphrase)
        for (const p of fromG) {
          if (!probes.some((x) => x.sacContractId === p.sacContractId)) probes.push(p)
        }
      }
    } catch {
      // keep native-only
    }
  }

  return probes.slice(0, MAX_SAC_PROBE_CONTRACTS)
}

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function paymentDedupeKey(tx: SmartAccountPayment): string {
  return `${tx.transactionHash || tx.id}|${tx.from}|${tx.to}|${tx.assetCode ?? 'XLM'}`
}

/**
 * G-address Horizon ops → payments.
 * Prefers asset_balance_changes; falls back to effects. Also maps classic payment /
 * create_account (G remapped to C so classifiers work).
 */
export async function fetchGAddressOps(
  horizonUrl: string,
  gAddress: string,
  cAddress: string,
  signal?: AbortSignal
): Promise<SmartAccountPayment[]> {
  const base = horizonUrl.replace(/\/$/, '')
  const resp = (await horizonGet(
    `${base}/accounts/${encodeURIComponent(gAddress)}/operations?limit=50&order=desc&include_failed=false`,
    signal
  )) as { _embedded?: { records?: unknown[] } } | null

  const allOps = (resp?._embedded?.records ?? []) as Record<string, unknown>[]
  if (allOps.length === 0) return []

  const results: SmartAccountPayment[] = []

  for (const op of allOps.filter((r) => r.type === 'payment')) {
    results.push({
      id: String(op.id),
      transactionHash: String(op.transaction_hash ?? ''),
      type: 'payment',
      from: op.from === gAddress ? cAddress : String(op.from ?? ''),
      to: op.to === gAddress ? cAddress : String(op.to ?? ''),
      amount: String(op.amount ?? '0'),
      assetType: String(op.asset_type ?? 'native'),
      assetCode: typeof op.asset_code === 'string' ? op.asset_code : undefined,
      createdAt: String(op.created_at ?? ''),
    })
  }

  for (const op of allOps.filter((r) => r.type === 'create_account')) {
    results.push({
      id: String(op.id),
      transactionHash: String(op.transaction_hash ?? ''),
      type: 'create_account',
      from: String(op.funder ?? ''),
      to: op.account === gAddress ? cAddress : String(op.account ?? ''),
      amount: String(op.starting_balance ?? '0'),
      assetType: 'native',
      createdAt: String(op.created_at ?? ''),
    })
  }

  const invokeOps = allOps.filter((r) => r.type === 'invoke_host_function')
  const needEffects: Record<string, unknown>[] = []

  for (const op of invokeOps) {
    const changes = (op.asset_balance_changes ?? []) as Record<string, unknown>[]
    const matched = changes.filter((c) => c.from === cAddress || c.to === cAddress)

    if (matched.length > 0) {
      matched.forEach((change, ci) => {
        results.push({
          id: matched.length > 1 ? `${String(op.id)}_${ci}` : String(op.id),
          transactionHash: String(op.transaction_hash ?? ''),
          type: 'invoke_host_function',
          from: String(change.from ?? ''),
          to: String(change.to ?? ''),
          amount: String(change.amount ?? '0'),
          assetType: change.asset_type === 'native' ? 'native' : 'credit_alphanum4',
          assetCode: typeof change.asset_code === 'string' ? change.asset_code : undefined,
          createdAt: String(op.created_at ?? ''),
        })
      })
    } else {
      needEffects.push(op)
    }
  }

  if (needEffects.length > 0) {
    const effectsBatch = await Promise.all(
      needEffects.map((op) =>
        horizonGet(`${base}/operations/${String(op.id)}/effects`, signal).then(
          (r) => (r as { _embedded?: { records?: unknown[] } } | null)?._embedded?.records ?? []
        )
      )
    )

    for (let i = 0; i < needEffects.length; i++) {
      const op = needEffects[i]!
      const effects = effectsBatch[i] as Record<string, unknown>[]
      const matchesCAddr = (e: Record<string, unknown>) =>
        e.contract === cAddress || e.account === cAddress
      const creditEffect = effects.find((e) => e.type === 'contract_credited' && matchesCAddr(e))
      const debitEffect = effects.find((e) => e.type === 'contract_debited' && matchesCAddr(e))
      if (!creditEffect && !debitEffect) continue

      const isIncoming = !!creditEffect
      const effect = (creditEffect ?? debitEffect)!
      results.push({
        id: String(op.id),
        transactionHash: String(op.transaction_hash ?? ''),
        type: 'invoke_host_function',
        from: isIncoming ? String(op.source_account) : cAddress,
        to: isIncoming ? cAddress : String(op.source_account),
        amount: String(effect.amount ?? '0'),
        assetType: effect.asset_type === 'native' ? 'native' : 'credit_alphanum4',
        assetCode: typeof effect.asset_code === 'string' ? effect.asset_code : undefined,
        createdAt: String(op.created_at ?? ''),
      })
    }
  }

  return results
}

/**
 * Bundler Horizon ops for passkey (and Latch↔Latch) activity.
 * Outer tx source is the bundler G; filter asset_balance_changes by C-address.
 */
export async function fetchBundlerOps(
  horizonUrl: string,
  bundlerGAddress: string,
  cAddress: string,
  signal?: AbortSignal
): Promise<SmartAccountPayment[]> {
  const base = horizonUrl.replace(/\/$/, '')
  const resp = (await horizonGet(
    `${base}/accounts/${encodeURIComponent(bundlerGAddress)}/operations?limit=200&order=desc&include_failed=false`,
    signal
  )) as { _embedded?: { records?: unknown[] } } | null

  const allOps = (resp?._embedded?.records ?? []) as Record<string, unknown>[]
  const invokeOps = allOps.filter((r) => r.type === 'invoke_host_function')
  const results: SmartAccountPayment[] = []

  for (const op of invokeOps) {
    const changes = (op.asset_balance_changes ?? []) as Record<string, unknown>[]
    const matched = changes.filter((c) => c.from === cAddress || c.to === cAddress)
    matched.forEach((change, ci) => {
      results.push({
        id: matched.length > 1 ? `${String(op.id)}_${ci}` : String(op.id),
        transactionHash: String(op.transaction_hash ?? ''),
        type: 'invoke_host_function',
        from: String(change.from ?? ''),
        to: String(change.to ?? ''),
        amount: String(change.amount ?? '0'),
        assetType: change.asset_type === 'native' ? 'native' : 'credit_alphanum4',
        assetCode: typeof change.asset_code === 'string' ? change.asset_code : undefined,
        createdAt: String(op.created_at ?? ''),
      })
    })
  }

  return results
}

type SorobanEventsPage = {
  result?: { events?: unknown[]; cursor?: string }
  error?: { message?: string }
}

/**
 * Fetch one direction of transfer events, shrinking reach on processing-limit errors.
 * Cost is a function of ledger range to chain tip — never grow past SAC_EVENTS_REACH_LEDGERS.
 */
async function fetchTransferEvents(
  rpcUrl: string,
  buildParams: (start: number) => object,
  latestLedger: number,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  let reach = SAC_EVENTS_REACH_LEDGERS

  for (;;) {
    const start = Math.max(1, latestLedger - reach)
    const resp = (await sorobanRpc(
      rpcUrl,
      'getEvents',
      buildParams(start),
      signal
    )) as SorobanEventsPage

    if (resp?.error) {
      if (reach <= SAC_EVENTS_MIN_REACH_LEDGERS) {
        throw new Error(resp.error.message || 'Soroban getEvents failed')
      }
      reach = Math.max(SAC_EVENTS_MIN_REACH_LEDGERS, Math.floor(reach / 2))
      continue
    }

    return (resp.result?.events ?? []) as Record<string, unknown>[]
  }
}

function parseTransferAmountRaw(event: Record<string, unknown>): bigint {
  const raw = event.value ?? event.valueXdr
  if (raw == null) return 0n
  try {
    const val = xdr.ScVal.fromXDR(String(raw), 'base64')
    const native = scValToNative(val)
    if (typeof native === 'bigint') return native >= 0n ? native : 0n
    if (typeof native === 'number' && Number.isFinite(native)) {
      return BigInt(Math.trunc(native))
    }
    if (native && typeof native === 'object' && 'amount' in native) {
      const amt = (native as { amount?: unknown }).amount
      if (typeof amt === 'bigint') return amt >= 0n ? amt : 0n
    }
    return BigInt(String(native ?? 0))
  } catch {
    return 0n
  }
}

/**
 * Wildcard-topic SAC transfer events for a C-address (any contract).
 * Incoming + outgoing in parallel; labels via assetInfoByContractId.
 */
export async function fetchSacTransferEvents(
  rpcUrl: string,
  cAddress: string,
  assetInfoByContractId: Map<string, SacAssetInfo>,
  signal?: AbortSignal
): Promise<SmartAccountPayment[]> {
  const latestLedgerResp = (await sorobanRpc(rpcUrl, 'getLatestLedger', {}, signal)) as {
    result?: { sequence?: number }
  }
  const latestLedger = latestLedgerResp?.result?.sequence ?? 0
  if (latestLedger === 0) return []

  const transferSym = scValB64(xdr.ScVal.scvSymbol('transfer'))
  const cAddressVal = scValB64(new Address(cAddress).toScVal())
  const wildcard = '*'

  const buildParams = (sender: string, recipient: string) => (start: number) => ({
    startLedger: start,
    filters: [
      {
        type: 'contract',
        topics: [[transferSym, sender, recipient, wildcard]],
      },
    ],
    pagination: { limit: 200 },
  })

  const [incoming, outgoing] = await Promise.all([
    fetchTransferEvents(rpcUrl, buildParams(wildcard, cAddressVal), latestLedger, signal),
    fetchTransferEvents(rpcUrl, buildParams(cAddressVal, wildcard), latestLedger, signal),
  ])

  const mapEvent = (event: Record<string, unknown>): SmartAccountPayment | null => {
    try {
      const topics = (event.topic ?? event.topicXdr ?? event.topics ?? []) as string[]
      if (topics.length < 3) return null

      const fnName = scValToNative(xdr.ScVal.fromXDR(topics[0]!, 'base64'))
      if (String(fnName) !== 'transfer') return null

      const from = Address.fromScVal(xdr.ScVal.fromXDR(topics[1]!, 'base64')).toString()
      const to = Address.fromScVal(xdr.ScVal.fromXDR(topics[2]!, 'base64')).toString()

      const amountRaw = parseTransferAmountRaw(event)
      const contractId = String(event.contractId ?? '')
      const assetInfo = assetInfoByContractId.get(contractId) ?? {
        code: 'XLM',
        assetType: 'native',
      }

      const txHash = String(event.txHash ?? event.transactionHash ?? '')
      const eventId = event.id != null ? String(event.id) : ''

      return {
        id: eventId || txHash,
        transactionHash: txHash,
        type: 'invoke_host_function',
        from,
        to,
        amount: formatSacRawToHuman(amountRaw, STELLAR_SAC_DISPLAY_DECIMALS),
        assetType: assetInfo.assetType,
        assetCode: assetInfo.code === 'XLM' ? undefined : assetInfo.code,
        createdAt: String(event.ledgerClosedAt ?? ''),
      }
    } catch {
      return null
    }
  }

  const seen = new Set<string>()
  const out: SmartAccountPayment[] = []
  for (const event of [...incoming, ...outgoing]) {
    const tx = mapEvent(event)
    if (!tx || !tx.transactionHash) continue
    const key = paymentDedupeKey(tx)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tx)
  }
  return out
}

/**
 * Group by transaction hash — multi-asset out+in under one hash is a swap.
 */
export function classifyPaymentTxTypes(
  payments: SmartAccountPayment[],
  cAddress: string
): SmartAccountPayment[] {
  const byHash = new Map<string, SmartAccountPayment[]>()
  for (const p of payments) {
    const key = p.transactionHash || p.id
    const group = byHash.get(key) ?? []
    group.push(p)
    byHash.set(key, group)
  }

  return payments.map((p) => {
    const key = p.transactionHash || p.id
    const group = byHash.get(key) ?? [p]

    const hasOutgoing = group.some((g) => stellarAddressEquals(g.from, cAddress))
    const hasIncoming = group.some((g) => stellarAddressEquals(g.to, cAddress))
    const distinctAssets = new Set(group.map((g) => g.assetCode ?? 'XLM')).size

    let txType: NonNullable<SmartAccountPayment['txType']>
    if (hasOutgoing && hasIncoming && distinctAssets > 1) {
      txType = 'swap'
    } else if (stellarAddressEquals(p.from, cAddress)) {
      txType = 'send'
    } else if (stellarAddressEquals(p.to, cAddress)) {
      txType = 'receive'
    } else {
      txType = 'unknown'
    }

    return { ...p, txType }
  })
}

export async function fetchSmartAccountPayments(params: {
  cAddress: string
  gAddress?: string | null
  /** Latch bundler / fee-payer public G (required for passkey history). */
  bundlerGAddress?: string | null
  horizonUrl: string
  rpcUrl: string
  networkPassphrase: string
  network?: StellarNetwork
  /** Extra SAC probes for asset labeling (portfolio / known tokens). */
  additionalProbes?: PortfolioTokenProbe[]
  signal?: AbortSignal
}): Promise<SmartAccountPayment[]> {
  let trustlineProbes: PortfolioTokenProbe[] = []
  try {
    trustlineProbes = await buildSacProbesForHistory({
      horizonUrl: params.horizonUrl,
      networkPassphrase: params.networkPassphrase,
      gAddress: params.gAddress,
      signal: params.signal,
    })
  } catch {
    // labeling only
  }

  const assetInfo = buildSacAssetInfoMap({
    networkPassphrase: params.networkPassphrase,
    network: params.network,
    additionalProbes: [...trustlineProbes, ...(params.additionalProbes ?? [])],
  })

  const bundlerG = params.bundlerGAddress?.trim()

  const [gAddrResult, bundlerResult, sacResult] = await Promise.allSettled([
    params.gAddress?.trim()
      ? fetchGAddressOps(params.horizonUrl, params.gAddress.trim(), params.cAddress, params.signal)
      : Promise.resolve([] as SmartAccountPayment[]),
    bundlerG
      ? fetchBundlerOps(params.horizonUrl, bundlerG, params.cAddress, params.signal)
      : Promise.resolve([] as SmartAccountPayment[]),
    fetchSacTransferEvents(params.rpcUrl, params.cAddress, assetInfo, params.signal),
  ])

  const failures: string[] = []
  if (params.gAddress?.trim() && gAddrResult.status === 'rejected') {
    failures.push(`G-address: ${failureMessage(gAddrResult.reason)}`)
  }
  if (bundlerG && bundlerResult.status === 'rejected') {
    failures.push(`bundler: ${failureMessage(bundlerResult.reason)}`)
  }
  if (sacResult.status === 'rejected') {
    failures.push(`SAC events: ${failureMessage(sacResult.reason)}`)
  }
  if (failures.length > 0) {
    throw new Error(`Transaction history incomplete — ${failures.join('; ')}`)
  }

  const gAddrTxs = gAddrResult.status === 'fulfilled' ? gAddrResult.value : []
  const bundlerTxs = bundlerResult.status === 'fulfilled' ? bundlerResult.value : []
  const sacTxs = sacResult.status === 'fulfilled' ? sacResult.value : []

  const seen = new Set<string>()
  const merged: SmartAccountPayment[] = []
  for (const tx of [...gAddrTxs, ...bundlerTxs, ...sacTxs]) {
    if (!tx.transactionHash) continue
    const key = paymentDedupeKey(tx)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(tx)
  }

  const sorted = merged.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
  return classifyPaymentTxTypes(sorted, params.cAddress)
}
