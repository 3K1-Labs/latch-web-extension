import { BackendError } from './client'
import { latchMarketApiBaseUrl, latchRequestTimeoutMs, noteLatchApiSuccess } from './config'
import { parseApiError } from './errors'

export type NormalizedTokenPrice = { priceUsd: number; change24h: number }

type RawPriceEntry =
  | number
  | {
      price?: string | number
      change_24h?: string | number
    }

/**
 * Normalize Render `/v1/prices` payloads.
 * Accepts `data[token]` as a bare number (Swagger) or `{ price, change_24h }` (legacy).
 */
export function normalizeMarketPricesData(
  data: Record<string, RawPriceEntry> | undefined
): Record<string, NormalizedTokenPrice> {
  const out: Record<string, NormalizedTokenPrice> = {}

  for (const [code, entry] of Object.entries(data ?? {})) {
    const upper = code.toUpperCase()
    let priceUsd: number
    let change24h = 0

    if (typeof entry === 'number') {
      priceUsd = entry
    } else if (entry && typeof entry === 'object') {
      const rawPrice = entry.price
      priceUsd = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice ?? ''))
      const rawChange = entry.change_24h
      change24h = typeof rawChange === 'number' ? rawChange : Number(rawChange)
    } else {
      continue
    }

    if (!Number.isFinite(priceUsd)) continue
    out[upper] = {
      priceUsd,
      change24h: Number.isFinite(change24h) ? change24h : 0,
    }
  }

  return out
}

export async function fetchMarketPricesNormalized(
  tokensLower: string[],
  opts?: { timeoutMs?: number }
): Promise<Record<string, NormalizedTokenPrice>> {
  const base = await latchMarketApiBaseUrl()
  const q = encodeURIComponent(tokensLower.join(','))
  const url = `${base}/prices?tokens=${q}`

  const controller = new AbortController()
  const timeoutMs = await latchRequestTimeoutMs(opts?.timeoutMs, 10_000)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    const text = await res.text()
    let data: unknown
    if (text) {
      try {
        data = JSON.parse(text) as unknown
      } catch {
        throw new BackendError(`Market API response was not valid JSON (${res.status}).`, {
          status: res.status,
          code: 'invalid_json',
        })
      }
    }

    if (!res.ok) {
      const { message, code } = parseApiError(res.status, data)
      throw new BackendError(message, { status: res.status, code, details: data })
    }

    const body = data as { data?: Record<string, RawPriceEntry> }
    const normalized = normalizeMarketPricesData(body.data)
    await noteLatchApiSuccess()
    return normalized
  } catch (err) {
    if (err instanceof BackendError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new BackendError('Request timed out', { code: 'timeout' })
    }
    throw new BackendError(err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timeout)
  }
}
