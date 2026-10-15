import {
  applyRegistryContractId,
  isTokenInSwapRegistry,
  resolveTokenListContractId,
  swapAssetKeyFromParts,
  type SwapProviderTokenEntry,
  type SwapProviderTokenRegistry,
} from '@latch/swap'
import { CURATED_PORTFOLIO_ASSETS } from '@latch/stellar'
import type { SmartAccountBalanceRow, SwapTokenRow } from '@latch/types'

import { fetchCombinedTokenLists, type TokenListItem } from '../assetTokenLists'
import { getActiveNetwork, networkPassphraseFor } from '../network/config'
import { runGetSmartAccountBalances } from '../smartAccountBalances'
import { loadSwapProviderRegistry } from './providerRegistry'

const RECEIVE_PRIORITY_SYMBOLS = ['USDC', 'EURC', 'XLM'] as const
const DEFAULT_DECIMALS = 7

const SWAP_CURATED_META: Record<string, { icon: string; name: string }> = {
  XLM: {
    icon: 'https://assets.coincap.io/assets/icons/xlm@2x.png',
    name: 'Stellar Lumens',
  },
  USDC: {
    icon: 'https://assets.coincap.io/assets/icons/usdc@2x.png',
    name: 'USD Coin',
  },
  EURC: {
    icon: 'https://assets.coincap.io/assets/icons/eurc@2x.png',
    name: 'EURC',
  },
  AQUA: {
    icon: 'https://assets.coincap.io/assets/icons/xlm@2x.png',
    name: 'AQUA',
  },
  USDT: {
    icon: 'https://assets.coincap.io/assets/icons/usdt@2x.png',
    name: 'Tether',
  },
}

function isAssetKeyLabel(label: string): boolean {
  const trimmed = label.trim()
  if (trimmed === 'native') return true
  const colon = trimmed.indexOf(':')
  if (colon <= 0) return false
  return trimmed
    .slice(colon + 1)
    .trim()
    .startsWith('G')
}

export function resolveSwapTokenDisplayName(
  symbol: string,
  options?: { listName?: string; providerLabel?: string }
): string {
  const listName = options?.listName?.trim()
  if (listName && !isAssetKeyLabel(listName)) return listName

  const curated = SWAP_CURATED_META[symbol.toUpperCase()]
  if (curated?.name) return curated.name

  const providerLabel = options?.providerLabel?.trim()
  if (providerLabel && !isAssetKeyLabel(providerLabel)) return providerLabel

  return symbol
}

function findListMetadataForEntry(
  entry: SwapProviderTokenEntry,
  listByKey: Map<string, TokenListItem>,
  listItems: TokenListItem[]
): TokenListItem | undefined {
  const key = swapTokenIdFromParts(entry.symbol, entry.issuer, entry.assetId)
  const direct = listByKey.get(key)
  if (direct) return direct

  const sameCode = listItems.filter(
    (item) => item.code.toUpperCase() === entry.symbol.toUpperCase()
  )
  if (entry.issuer) {
    const issuerMatch = sameCode.find((item) => item.issuer === entry.issuer)
    if (issuerMatch) return issuerMatch
  }
  return sameCode.find((item) => item.name?.trim()) ?? sameCode[0]
}

export function swapTokenIdFromParts(code: string, issuer?: string, assetId?: string): string {
  return swapAssetKeyFromParts(code, issuer, assetId)
}

export function balanceRowToSwapToken(row: SmartAccountBalanceRow): SwapTokenRow {
  const assetId = row.assetId ?? (row.code.toUpperCase() === 'XLM' ? 'native' : row.code)
  const id = swapTokenIdFromParts(row.code, row.issuer, assetId)
  return {
    id,
    symbol: row.code,
    name: resolveSwapTokenDisplayName(row.code),
    assetId,
    contractId: row.sacContractId,
    decimals: row.decimals ?? DEFAULT_DECIMALS,
    balance: row.amount,
    issuer: row.issuer,
    iconUrl: row.iconUrl,
  }
}

function parseBalanceAmount(amount: string): number {
  const n = Number.parseFloat(amount)
  return Number.isFinite(n) ? n : 0
}

export function buildPayTokensFromBalances(
  rows: SmartAccountBalanceRow[],
  registry?: SwapProviderTokenRegistry
): SwapTokenRow[] {
  const tokens = rows
    .filter((r) => parseBalanceAmount(r.amount) > 0)
    .map(balanceRowToSwapToken)
    .map((token) => (registry ? applyRegistryContractId(token, registry) : token))
    .filter((token) => !registry || isTokenInSwapRegistry(token, registry))

  if (tokens.length === 0) {
    const native = rows.find((r) => r.code.toUpperCase() === 'XLM')
    if (native) {
      const token = balanceRowToSwapToken(native)
      const resolved = registry ? applyRegistryContractId(token, registry) : token
      if (!registry || isTokenInSwapRegistry(resolved, registry)) {
        tokens.push(resolved)
      }
    }
  }

  return tokens.sort((a, b) => a.symbol.localeCompare(b.symbol))
}

export function resolveListItemContractId(
  item: TokenListItem,
  networkPassphrase: string,
  registry?: SwapProviderTokenRegistry
): string | null {
  if (!item.code) return null

  const isNative = item.code.toUpperCase() === 'XLM' && !item.issuer
  const assetId = isNative ? 'native' : item.code
  const assetKey = swapTokenIdFromParts(item.code, item.issuer || undefined, assetId)
  const registryEntry = registry?.byAssetKey.get(assetKey)
  if (registryEntry) return registryEntry.contractId

  return resolveTokenListContractId(item, networkPassphrase)
}

export function curatedSwapReceiveListItems(network: 'testnet' | 'mainnet'): TokenListItem[] {
  return CURATED_PORTFOLIO_ASSETS[network].map((asset) => {
    const meta = SWAP_CURATED_META[asset.code.toUpperCase()]
    return {
      code: asset.code,
      issuer: asset.issuer ?? '',
      icon: meta?.icon ?? 'https://assets.coincap.io/assets/icons/xlm@2x.png',
      name: meta?.name ?? asset.code,
      decimals: asset.decimals ?? DEFAULT_DECIMALS,
    }
  })
}

export function preferredReceiveTokenIds(network: 'testnet' | 'mainnet'): string[] {
  return curatedSwapReceiveListItems(network).map((item) =>
    swapTokenIdFromParts(
      item.code,
      item.issuer || undefined,
      item.code.toUpperCase() === 'XLM' ? 'native' : item.code
    )
  )
}

function shouldIncludeExternalListItem(
  item: TokenListItem,
  network: 'testnet' | 'mainnet',
  heldIssuerKeys: Set<string>
): boolean {
  const code = item.code.toUpperCase()
  const curated = CURATED_PORTFOLIO_ASSETS[network]
  const curatedForCode = curated.filter((c) => c.code.toUpperCase() === code)
  if (curatedForCode.length === 0) return true
  if (!item.issuer) return code === 'XLM'
  const fullKey = swapTokenIdFromParts(item.code, item.issuer, item.code)
  if (heldIssuerKeys.has(fullKey)) return true
  if (network === 'mainnet') return true
  return curatedForCode.some((c) => c.issuer === item.issuer)
}

export function listItemToSwapToken(
  item: TokenListItem,
  networkPassphrase: string,
  balanceRow?: SmartAccountBalanceRow,
  registry?: SwapProviderTokenRegistry
): SwapTokenRow | null {
  if (!item.code) return null
  const contractId = resolveListItemContractId(item, networkPassphrase, registry)
  if (!contractId) return null

  const isNative = item.code.toUpperCase() === 'XLM' && !item.issuer
  const assetId = isNative ? 'native' : item.code
  const id = swapTokenIdFromParts(item.code, item.issuer || undefined, assetId)

  if (balanceRow) {
    const fromBalance = balanceRowToSwapToken(balanceRow)
    return {
      ...fromBalance,
      contractId,
      name: resolveSwapTokenDisplayName(item.code, { listName: item.name }),
      iconUrl: balanceRow.iconUrl ?? item.icon,
      decimals: item.decimals ?? fromBalance.decimals,
    }
  }

  return {
    id,
    symbol: item.code,
    name: resolveSwapTokenDisplayName(item.code, { listName: item.name }),
    assetId,
    contractId,
    decimals: item.decimals ?? DEFAULT_DECIMALS,
    balance: '0',
    issuer: item.issuer || undefined,
    iconUrl: item.icon,
  }
}

function balanceRowKey(row: SmartAccountBalanceRow): string {
  return swapTokenIdFromParts(
    row.code,
    row.issuer,
    row.assetId ?? (row.code.toUpperCase() === 'XLM' ? 'native' : row.code)
  )
}

export function sortReceiveTokens(tokens: SwapTokenRow[]): SwapTokenRow[] {
  const priorityIndex = (symbol: string) => {
    const upper = symbol.toUpperCase()
    const idx = RECEIVE_PRIORITY_SYMBOLS.indexOf(upper as (typeof RECEIVE_PRIORITY_SYMBOLS)[number])
    return idx >= 0 ? idx : RECEIVE_PRIORITY_SYMBOLS.length
  }

  return [...tokens].sort((a, b) => {
    const aHeld = parseBalanceAmount(a.balance) > 0
    const bHeld = parseBalanceAmount(b.balance) > 0
    if (aHeld !== bHeld) return aHeld ? -1 : 1

    const aPri = priorityIndex(a.symbol)
    const bPri = priorityIndex(b.symbol)
    if (aPri !== bPri) return aPri - bPri

    return a.symbol.localeCompare(b.symbol)
  })
}

function registryEntryToSwapToken(
  entry: SwapProviderTokenEntry,
  balanceRow?: SmartAccountBalanceRow,
  listItem?: TokenListItem
): SwapTokenRow {
  const id = swapTokenIdFromParts(entry.symbol, entry.issuer, entry.assetId)
  const displayName = resolveSwapTokenDisplayName(entry.symbol, {
    listName: listItem?.name,
    providerLabel: entry.label,
  })
  const iconUrl =
    listItem?.icon ?? balanceRow?.iconUrl ?? SWAP_CURATED_META[entry.symbol.toUpperCase()]?.icon

  if (balanceRow) {
    const fromBalance = balanceRowToSwapToken(balanceRow)
    return {
      ...fromBalance,
      id,
      symbol: entry.symbol,
      name: displayName,
      assetId: entry.assetId,
      contractId: entry.contractId,
      issuer: entry.issuer,
      decimals: listItem?.decimals ?? fromBalance.decimals ?? DEFAULT_DECIMALS,
      iconUrl,
    }
  }

  return {
    id,
    symbol: entry.symbol,
    name: displayName,
    assetId: entry.assetId,
    contractId: entry.contractId,
    decimals: listItem?.decimals ?? DEFAULT_DECIMALS,
    balance: '0',
    issuer: entry.issuer,
    iconUrl,
  }
}

function listItemsByAssetKey(listItems: TokenListItem[]): Map<string, TokenListItem> {
  const listByKey = new Map<string, TokenListItem>()
  for (const item of listItems) {
    if (!item.code) continue
    const key = swapTokenIdFromParts(
      item.code,
      item.issuer || undefined,
      item.code.toUpperCase() === 'XLM' ? 'native' : item.code
    )
    if (!listByKey.has(key)) listByKey.set(key, item)
  }
  return listByKey
}

export function buildReceiveTokensFromRegistry(
  registry: SwapProviderTokenRegistry,
  listItems: TokenListItem[],
  balanceRows: SmartAccountBalanceRow[],
  network: 'testnet' | 'mainnet' = 'mainnet'
): SwapTokenRow[] {
  const balanceById = new Map(balanceRows.map((row) => [balanceRowKey(row), row]))
  const listByKey = listItemsByAssetKey(listItems)

  for (const item of curatedSwapReceiveListItems(network)) {
    const key = swapTokenIdFromParts(
      item.code,
      item.issuer || undefined,
      item.code.toUpperCase() === 'XLM' ? 'native' : item.code
    )
    if (!listByKey.has(key)) listByKey.set(key, item)
  }

  const tokens = [...registry.byContractId.values()].map((entry) => {
    const id = swapTokenIdFromParts(entry.symbol, entry.issuer, entry.assetId)
    const listItem = findListMetadataForEntry(entry, listByKey, listItems)
    return registryEntryToSwapToken(entry, balanceById.get(id), listItem)
  })

  return sortReceiveTokens(tokens)
}

export function buildReceiveTokensFromListsAndBalances(
  listItems: TokenListItem[],
  balanceRows: SmartAccountBalanceRow[],
  networkPassphrase: string,
  network: 'testnet' | 'mainnet' = 'mainnet',
  registry?: SwapProviderTokenRegistry
): SwapTokenRow[] {
  if (registry) {
    return buildReceiveTokensFromRegistry(registry, listItems, balanceRows, network)
  }

  const balanceById = new Map(balanceRows.map((row) => [balanceRowKey(row), row]))
  const heldIssuerKeys = new Set(balanceById.keys())
  const byId = new Map<string, SwapTokenRow>()

  const nativeXlm: TokenListItem = {
    code: 'XLM',
    issuer: '',
    icon: 'https://assets.coincap.io/assets/icons/xlm@2x.png',
    name: 'Stellar Lumens',
  }

  const curated = curatedSwapReceiveListItems(network)
  const externalItems = listItems.filter((item) =>
    shouldIncludeExternalListItem(item, network, heldIssuerKeys)
  )
  const items = [nativeXlm, ...curated, ...externalItems]
  const seenListKeys = new Set<string>()

  for (const item of items) {
    const listKey = `${item.code}:${item.issuer}:${item.contract ?? ''}`
    if (seenListKeys.has(listKey)) continue
    seenListKeys.add(listKey)

    const balanceRow = balanceById.get(
      swapTokenIdFromParts(
        item.code,
        item.issuer || undefined,
        item.code.toUpperCase() === 'XLM' ? 'native' : item.code
      )
    )
    const token = listItemToSwapToken(item, networkPassphrase, balanceRow, registry)
    if (!token) continue
    byId.set(token.id, token)
  }

  for (const row of balanceRows) {
    const token = balanceRowToSwapToken(row)
    if (!byId.has(token.id)) {
      byId.set(token.id, token)
    }
  }

  return sortReceiveTokens([...byId.values()])
}

export async function loadPayTokens(accountId: string): Promise<SwapTokenRow[]> {
  const [balances, registry] = await Promise.all([
    runGetSmartAccountBalances(accountId),
    loadSwapProviderRegistry(),
  ])
  return buildPayTokensFromBalances(balances.rows, registry)
}

export async function loadReceiveTokens(accountId: string): Promise<SwapTokenRow[]> {
  const network = await getActiveNetwork()
  const passphrase = networkPassphraseFor(network)
  const [balances, listItems, registry] = await Promise.all([
    runGetSmartAccountBalances(accountId),
    fetchCombinedTokenLists(network),
    loadSwapProviderRegistry(),
  ])
  return buildReceiveTokensFromListsAndBalances(
    listItems,
    balances.rows,
    passphrase,
    network,
    registry
  )
}

export function findSwapToken(tokens: SwapTokenRow[], id: string): SwapTokenRow | undefined {
  return tokens.find((t) => t.id === id)
}
