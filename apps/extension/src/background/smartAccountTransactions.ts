import {
  buildSmartAccountPortfolioProbes,
  fetchSmartAccountPayments,
  stellarAddressEquals,
  type SmartAccountPayment,
} from '@latch/stellar'

import type { GetSmartAccountTransactionsResponse, SmartAccountTransactionRow } from '@latch/types'
import type { Network } from '@latch/types'

import { getKnownSacProbes, recordKnownSacProbes } from './knownSacProbes'
import {
  getActiveNetwork,
  horizonUrlFor,
  networkPassphraseFor,
  sorobanRpcUrlFor,
} from './network/config'
import { mergeActivityRows, readActivityHistory, writeActivityHistory } from './activityHistory'
import { getAccounts } from './storage'
import { getMarketPrices } from './marketPrices'
import { computeBalanceUsd } from './tokenPrices'

/** Public bundler G from env (same as swap fee-payer). Avoid importing @latch/swap barrel here. */
function resolveBundlerPublicG(network: Network): string | undefined {
  if (network === 'mainnet') {
    const mainnet = process.env.PLASMO_PUBLIC_LATCH_FEE_PAYER_G_MAINNET?.trim()
    if (mainnet?.startsWith('G')) return mainnet
    return undefined
  }
  const fromEnv = process.env.PLASMO_PUBLIC_LATCH_FEE_PAYER_G?.trim()
  return fromEnv?.startsWith('G') ? fromEnv : undefined
}

type Snapshot = {
  updatedAtMs: number
  data: GetSmartAccountTransactionsResponse
}

const FRESH_TTL_MS = 60_000

let memoryCacheByAccountId: Map<string, Snapshot> | null = null
const inflightByAccountId: Map<string, Promise<GetSmartAccountTransactionsResponse>> = new Map()

export function clearSmartAccountTransactionsMemoryCache(): void {
  memoryCacheByAccountId = null
  inflightByAccountId.clear()
}

function snapshotFreshEnough(s: Snapshot, now: number): boolean {
  return now - s.updatedAtMs < FRESH_TTL_MS
}

function classifyKind(
  tx: SmartAccountPayment,
  cAddress: string,
  gAddress?: string
): SmartAccountTransactionRow['kind'] {
  if (tx.txType === 'swap') return 'swap'
  if (
    stellarAddressEquals(tx.to, cAddress) &&
    gAddress &&
    stellarAddressEquals(tx.from, gAddress)
  ) {
    return 'deposit'
  }
  if (tx.txType === 'send' || stellarAddressEquals(tx.from, cAddress)) return 'sent'
  if (tx.txType === 'receive' || stellarAddressEquals(tx.to, cAddress)) return 'received'
  return 'received'
}

async function computeTransactionsOnce(
  accountId: string
): Promise<GetSmartAccountTransactionsResponse> {
  const { accounts } = await getAccounts()
  const acc = accounts.find((a) => a.id === accountId)
  const c = acc?.smartAccountAddress?.trim()
  if (!c) return { items: [] }

  const g = acc?.gAddress?.trim()
  const network = await getActiveNetwork()
  const horizonUrl = horizonUrlFor(network)
  const rpcUrl = sorobanRpcUrlFor(network)
  const networkPassphrase = networkPassphraseFor(network)
  const bundlerGAddress = resolveBundlerPublicG(network)
  const additionalProbes = await getKnownSacProbes(accountId)

  const payments = await fetchSmartAccountPayments({
    cAddress: c,
    gAddress: g,
    bundlerGAddress,
    horizonUrl,
    rpcUrl,
    networkPassphrase,
    network,
    additionalProbes,
  })

  void buildSmartAccountPortfolioProbes({
    network,
    networkPassphrase,
    gAddress: g,
    horizonUrl,
    additionalProbes,
  }).then((probes) => recordKnownSacProbes(accountId, probes))

  const codes = payments.map((p) => p.assetCode ?? (p.assetType === 'native' ? 'XLM' : 'ASSET'))
  const { pricesByCodeUpper } = await getMarketPrices(codes)

  const items: SmartAccountTransactionRow[] = payments.map((p) => {
    const code = p.assetCode ?? (p.assetType === 'native' ? 'XLM' : 'ASSET')
    const kind = classifyKind(p, c, g)
    const isSent = kind === 'sent' || (kind === 'swap' && stellarAddressEquals(p.from, c))
    const sign = isSent ? '-' : '+'
    const amountNum = parseFloat(p.amount)
    const amountLabel = Number.isFinite(amountNum)
      ? `${sign}${amountNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`
      : `${sign}${p.amount} ${code}`
    const priceUsd = pricesByCodeUpper[code.toUpperCase()]?.priceUsd
    const usd = computeBalanceUsd(p.amount.replace(/^-/, ''), priceUsd)
    const amountUsd = usd != null ? `${isSent ? '-' : '+'}$${usd}` : null

    return {
      id: p.id,
      transactionHash: p.transactionHash,
      createdAt: p.createdAt,
      direction: isSent ? 'sent' : 'received',
      assetCode: code,
      amount: p.amount,
      amountLabel,
      amountUsd,
      status: 'completed',
      kind,
      from: p.from,
      to: p.to,
    }
  })

  return { items }
}

function trackInflight(
  accountId: string,
  p: Promise<GetSmartAccountTransactionsResponse>
): Promise<GetSmartAccountTransactionsResponse> {
  inflightByAccountId.set(accountId, p)
  return p.finally(() => {
    if (inflightByAccountId.get(accountId) === p) {
      inflightByAccountId.delete(accountId)
    }
  })
}

async function rememberSuccessfulScan(
  accountId: string,
  data: GetSmartAccountTransactionsResponse
): Promise<GetSmartAccountTransactionsResponse> {
  const stored = await readActivityHistory(accountId)
  const items = mergeActivityRows(data.items, stored)
  try {
    await writeActivityHistory(accountId, items)
  } catch {
    // The merged list is still returned for this session.
  }
  return { items }
}

export async function runGetSmartAccountTransactions(
  accountId: string,
  opts?: { force?: boolean }
): Promise<GetSmartAccountTransactionsResponse> {
  const now = Date.now()
  if (!memoryCacheByAccountId) {
    memoryCacheByAccountId = new Map()
  }

  const force = opts?.force === true

  if (!force) {
    const mem = memoryCacheByAccountId.get(accountId)
    if (mem && snapshotFreshEnough(mem, now)) return mem.data

    const existing = inflightByAccountId.get(accountId)
    if (existing) return await existing
  }

  const p = computeTransactionsOnce(accountId).then((data) =>
    rememberSuccessfulScan(accountId, data)
  )

  try {
    const data = await trackInflight(accountId, p)
    const snapshot: Snapshot = { updatedAtMs: Date.now(), data }
    memoryCacheByAccountId.set(accountId, snapshot)
    return data
  } catch (e) {
    const stored = await readActivityHistory(accountId)
    if (stored.length > 0) return { items: stored }
    const fallback = memoryCacheByAccountId.get(accountId)
    if (fallback && fallback.data.items.length > 0) return fallback.data
    throw e
  }
}
