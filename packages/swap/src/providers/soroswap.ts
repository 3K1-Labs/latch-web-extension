import { SOROSWAP_API_BASE, SOROSWAP_CONFIG } from '../constants'
import { applySlippageMin, QUOTE_TTL_MS } from '../amounts'
import type { SoroswapBuildPayload, SwapProvider, SwapQuote, SwapQuoteRequest } from '../types'
import { buildSoroswapAggregatorUnsignedTx } from './soroswapBuild'
import { parseSoroswapDistribution } from './soroswapQuote'

const PROTOCOLS_WITH_AQUA = ['soroswap', 'phoenix', 'aqua'] as const
const PROTOCOLS_WITHOUT_AQUA = ['soroswap', 'phoenix'] as const

type SoroswapQuoteResponse = {
  amountIn?: string | number
  amountOut?: string | number
  /** Slippage-adjusted minimum from the API (preferred when present). */
  otherAmountThreshold?: string | number
  assetIn?: string
  assetOut?: string
  tradeType?: string
  protocols?: string[]
  path?: string[]
  [key: string]: unknown
}

function soroswapApiKey(): string {
  const key = process.env.PLASMO_PUBLIC_SOROSWAP_API_KEY?.trim()
  if (!key) {
    throw new Error('Soroswap API key not configured (PLASMO_PUBLIC_SOROSWAP_API_KEY)')
  }
  return key
}

async function soroswapPost<T>(
  endpoint: string,
  network: 'testnet' | 'mainnet',
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${SOROSWAP_API_BASE}${endpoint}?network=${network}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${soroswapApiKey()}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    throw new Error(err.message ?? err.error ?? `Soroswap API error (${res.status})`)
  }
  return (await res.json()) as T
}

function parseSoroswapQuote(data: SoroswapQuoteResponse, req: SwapQuoteRequest): SwapQuote {
  // API may JSON-encode amounts as numbers; keep raw units as strings for UI helpers.
  const amountOutRaw = data.amountOut != null ? String(data.amountOut) : ''
  if (!amountOutRaw) {
    throw new Error('No swap route found for this pair')
  }

  // Prefer API threshold when present; still clamp client-side for UI consistency.
  const apiMin = data.otherAmountThreshold != null ? String(data.otherAmountThreshold) : null
  const clientMin = applySlippageMin(amountOutRaw, req.slippageBps)
  let amountOutMinRaw = clientMin
  if (apiMin && /^\d+$/.test(apiMin)) {
    amountOutMinRaw = BigInt(apiMin) < BigInt(clientMin) ? apiMin : clientMin
  }

  const buildPayload: SoroswapBuildPayload = {
    kind: 'soroswap',
    quote: data as Record<string, unknown>,
    routerContractId: SOROSWAP_CONFIG[req.network].routerContractId,
  }

  return {
    providerId: 'soroswap',
    providerName: 'Soroswap',
    amountInRaw: req.amountInRaw,
    amountOutRaw,
    amountOutMinRaw,
    pathLabels: [req.assetIn.symbol, req.assetOut.symbol],
    expiresAtMs: Date.now() + QUOTE_TTL_MS,
    buildPayload,
  }
}

function isMissingAquaPoolHashes(err: unknown): boolean {
  return err instanceof Error && err.message.includes('missing pool hashes')
}

function quoteBody(req: SwapQuoteRequest, protocols: readonly string[]): Record<string, unknown> {
  return {
    assetIn: req.assetIn.contractId,
    assetOut: req.assetOut.contractId,
    amount: req.amountInRaw,
    tradeType: 'EXACT_IN',
    protocols,
    // API default is 50; send explicitly so otherAmountThreshold matches UI slippage.
    slippageBps: req.slippageBps,
  }
}

export const soroswapProvider: SwapProvider = {
  id: 'soroswap',
  name: 'Soroswap',
  async quote(req: SwapQuoteRequest): Promise<SwapQuote> {
    let data = await soroswapPost<SoroswapQuoteResponse>(
      '/quote',
      req.network,
      quoteBody(req, PROTOCOLS_WITH_AQUA)
    )
    try {
      parseSoroswapDistribution(data)
    } catch (err) {
      if (!isMissingAquaPoolHashes(err)) throw err
      // Aquarius hop had no usable pool hashes. Re-quote without aqua so the
      // returned amountOut matches the route we can actually build.
      data = await soroswapPost<SoroswapQuoteResponse>(
        '/quote',
        req.network,
        quoteBody(req, PROTOCOLS_WITHOUT_AQUA)
      )
      parseSoroswapDistribution(data)
    }
    return parseSoroswapQuote(data, req)
  },
  async buildUnsignedTx(
    req,
    quote,
    smartAccountAddress,
    transactionSourceG,
    rpcUrl,
    networkPassphrase
  ) {
    if (quote.buildPayload.kind !== 'soroswap') {
      throw new Error('Invalid build payload for Soroswap provider')
    }
    // Do not call Soroswap /quote/build — it expects a classic G wallet as `from`.
    // Build aggregator invoke XDR locally (bundler G source + smart account as `to`).
    return buildSoroswapAggregatorUnsignedTx({
      network: req.network,
      smartAccountAddress,
      transactionSourceG,
      buildPayload: quote.buildPayload,
      amountInRaw: quote.amountInRaw,
      amountOutMinRaw: quote.amountOutMinRaw,
      tokenInContractId: req.assetIn.contractId,
      tokenOutContractId: req.assetOut.contractId,
      rpcUrl,
      networkPassphrase,
      slippageBps: req.slippageBps,
    })
  },
}
