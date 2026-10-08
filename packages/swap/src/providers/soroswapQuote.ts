/**
 * Helpers for Soroswap quote → on-chain DexDistribution encoding.
 * Aquarius pool indexes arrive from /quote as 64-char hex; aggregator expects BytesN<32>.
 */

export function poolHashToBytes(hash: string): Buffer {
  const trimmed = hash.trim()
  if (!trimmed) {
    throw new Error('Invalid poolHashes string: empty')
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }

  // Base64-encoded 32-byte hash (legacy / alternate quote shapes).
  if (/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64')
    if (buf.length !== 32) {
      throw new Error(`Invalid poolHashes string: ${trimmed}`)
    }
    return buf
  }

  throw new Error(`Invalid poolHashes string: ${trimmed}`)
}

/** @deprecated Prefer poolHashToBytes for local aggregator XDR builds. */
export function normalizePoolHashForBuild(hash: string): string {
  return poolHashToBytes(hash).toString('base64')
}

type DistributionLike = {
  poolHashes?: unknown
  [key: string]: unknown
}

type RawTradeLike = {
  distribution?: DistributionLike[]
  [key: string]: unknown
}

/**
 * Deep-clone a Soroswap quote and normalize aqua `poolHashes` to Base64.
 * Used only when re-serializing quote payloads; local XDR build uses {@link poolHashToBytes}.
 */
export function normalizeSoroswapQuoteForBuild(
  quote: Record<string, unknown>
): Record<string, unknown> {
  const cloned = structuredClone(quote) as {
    rawTrade?: RawTradeLike
    [key: string]: unknown
  }

  const distribution = cloned.rawTrade?.distribution
  if (!Array.isArray(distribution)) return cloned

  for (const entry of distribution) {
    if (!entry || typeof entry !== 'object') continue
    const hashes = entry.poolHashes
    if (!Array.isArray(hashes)) continue
    entry.poolHashes = hashes.map((h) => {
      if (typeof h !== 'string') {
        throw new Error(`Invalid poolHashes string: ${String(h)}`)
      }
      return normalizePoolHashForBuild(h)
    })
  }

  return cloned
}

export type SoroswapDistributionEntry = {
  protocolId: string
  path: string[]
  parts: number
  poolHashes?: string[]
}

export function parseSoroswapDistribution(
  quote: Record<string, unknown>
): SoroswapDistributionEntry[] {
  const rawTrade = quote.rawTrade as RawTradeLike | undefined
  const distribution = rawTrade?.distribution
  if (!Array.isArray(distribution) || distribution.length === 0) {
    throw new Error('Soroswap quote is missing rawTrade.distribution')
  }

  return distribution.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid Soroswap distribution entry at ${index}`)
    }
    const protocolId = String(entry.protocol_id ?? entry.protocolId ?? '').toLowerCase()
    if (!protocolId) {
      throw new Error(`Soroswap distribution entry ${index} missing protocol_id`)
    }
    const path = entry.path
    if (!Array.isArray(path) || path.length < 2 || !path.every((p) => typeof p === 'string')) {
      throw new Error(`Soroswap distribution entry ${index} has an invalid path`)
    }
    const partsRaw = entry.parts
    const parts = typeof partsRaw === 'number' ? partsRaw : Number(partsRaw)
    if (!Number.isFinite(parts) || parts <= 0) {
      throw new Error(`Soroswap distribution entry ${index} has invalid parts`)
    }
    const poolHashes = readPoolHashList(entry)
    const hops = (path as string[]).length - 1
    if (protocolId === 'aqua' || protocolId === 'aquarius') {
      if (!poolHashes || poolHashes.length !== hops) {
        throw new Error(
          `Soroswap ${protocolId} route is missing pool hashes (expected ${hops} for ${hops} hop${hops === 1 ? '' : 's'}).`
        )
      }
      for (const hash of poolHashes) {
        poolHashToBytes(hash)
      }
    }

    return {
      protocolId,
      path: path as string[],
      parts: Math.floor(parts),
      poolHashes,
    }
  })
}

/** First present hash array. Aquarius quotes use poolHashes, pool_hashes, or bytes. */
function readPoolHashList(entry: DistributionLike): string[] | undefined {
  const candidates = [entry.poolHashes, entry.pool_hashes, entry.bytes]
  for (const raw of candidates) {
    if (!Array.isArray(raw)) continue
    return raw.map((h) => {
      if (typeof h !== 'string') {
        throw new Error(`Invalid poolHashes string: ${String(h)}`)
      }
      return h
    })
  }
  return undefined
}

/** Soroswap aggregator Protocol enum (#[repr(u32)]). */
export function soroswapProtocolIdToU32(protocolId: string): number {
  switch (protocolId.toLowerCase()) {
    case 'soroswap':
      return 0
    case 'phoenix':
      return 1
    case 'aqua':
    case 'aquarius':
      return 2
    case 'comet':
      return 3
    default:
      throw new Error(`Unknown Soroswap protocol_id: ${protocolId}`)
  }
}
