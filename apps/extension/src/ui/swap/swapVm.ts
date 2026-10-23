import type { NetworkFee, SwapQuotePayload } from '@latch/types'

import { rawToHuman, rawToNumber } from '@latch/swap'

import { formatNetworkFeeLine } from '../lib/networkFee'

export type SwapTokenVm = {
  id: string
  symbol: string
  name: string
  assetId: string
  contractId: string
  decimals: number
  balance: string
  issuer?: string
  iconUrl?: string | null
}

export type SwapDraft = {
  payTokenId: string
  receiveTokenId: string
  payAmount: string
  useExchangeBalance: boolean
  approved: boolean
}

export type SwapQuoteVm = {
  provider: string
  rateLine: string
  slippageLine: string
  minReceivedLine: string
  networkFeeLine: string
  receiveAmount: number
  receiveUsdApprox: string
  receiveAmountLine: string
  receiveUsdApproxLine: string
  quotePayload: SwapQuotePayload
}

export const DEFAULT_SLIPPAGE_BPS = 50

export function truncateAddress(addr: string, left = 6, right = 4) {
  if (addr.length <= left + right + 3) return addr
  return `${addr.slice(0, left)}...${addr.slice(-right)}`
}

export function toPositiveNumberOrNull(text: string): number | null {
  const cleaned = text.replace(/[^\d.]/g, '')
  if (cleaned.length === 0) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

export function formatCompactAmount(n: number, decimals = 2) {
  if (!Number.isFinite(n)) return '--'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs < 1) return n.toFixed(Math.min(6, Math.max(2, decimals + 2)))
  if (abs < 1000) return n.toFixed(decimals)
  if (abs < 1_000_000) return `${(n / 1000).toFixed(2)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatUsdApprox(amountUsd: number) {
  if (!Number.isFinite(amountUsd)) return '≈ --'
  return `≈ $${amountUsd.toFixed(2)}`
}

export function swapQuotePayloadToVm(
  payload: SwapQuotePayload,
  payTokenPriceUsd?: number | null,
  receiveTokenPriceUsd?: number | null,
  networkFee?: NetworkFee | null
): SwapQuoteVm {
  const receiveAmount = rawToNumber(payload.amountOutRaw, payload.assetOut.decimals)
  const minReceived = rawToHuman(payload.amountOutMinRaw, payload.assetOut.decimals)
  const payHuman = rawToHuman(payload.amountInRaw, payload.assetIn.decimals)
  const payN = Number.parseFloat(payHuman)
  const rate = payN > 0 && receiveAmount > 0 ? receiveAmount / payN : 0

  const payUsd =
    payTokenPriceUsd != null && Number.isFinite(payTokenPriceUsd) ? payN * payTokenPriceUsd : NaN
  const receiveUsd =
    receiveTokenPriceUsd != null && Number.isFinite(receiveTokenPriceUsd)
      ? receiveAmount * receiveTokenPriceUsd
      : payUsd

  const slippagePct = (payload.slippageBps / 100).toFixed(1)

  return {
    provider: payload.providerName,
    rateLine:
      rate > 0
        ? `1 ${payload.assetIn.symbol} ≈ ${rate.toFixed(6)} ${payload.assetOut.symbol}`
        : `—`,
    slippageLine: `Auto | ${slippagePct}%`,
    minReceivedLine: `${minReceived} ${payload.assetOut.symbol}`,
    networkFeeLine: formatNetworkFeeLine(networkFee) ?? '~ — Stellar',
    receiveAmount,
    receiveUsdApprox: Number.isFinite(receiveUsd) ? formatUsdApprox(receiveUsd) : '≈--',
    receiveAmountLine: `+${formatCompactAmount(receiveAmount, 6)} ${payload.assetOut.symbol}`,
    receiveUsdApproxLine: Number.isFinite(receiveUsd) ? `≈ $${receiveUsd.toFixed(2)}` : '',
    quotePayload: payload,
  }
}

export function parseBalanceAmount(balance: string): number {
  const n = Number.parseFloat(balance.replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

export function pickDefaultReceiveTokenId(
  payTokenId: string,
  receiveCatalog: SwapTokenVm[],
  preferredIds?: string[]
): string {
  if (preferredIds) {
    for (const id of preferredIds) {
      if (id !== payTokenId && receiveCatalog.some((t) => t.id === id)) return id
    }
  }
  for (const sym of ['USDC', 'EURC']) {
    const hit = receiveCatalog.find((t) => t.symbol.toUpperCase() === sym && t.id !== payTokenId)
    if (hit) return hit.id
  }
  return receiveCatalog.find((t) => t.id !== payTokenId)?.id ?? receiveCatalog[0]?.id ?? payTokenId
}

export function mergeSwapTokenCatalogs(
  payCatalog: SwapTokenVm[],
  receiveCatalog: SwapTokenVm[]
): SwapTokenVm[] {
  const byId = new Map<string, SwapTokenVm>()
  for (const t of [...payCatalog, ...receiveCatalog]) {
    if (!byId.has(t.id)) byId.set(t.id, t)
  }
  return [...byId.values()]
}

export function formatQuoteRemainingMs(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) return `${min}:${String(sec).padStart(2, '0')}`
  return `${sec}s`
}
