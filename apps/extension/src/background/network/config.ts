/**
 * Single source of truth for active Stellar network + Horizon/Soroban endpoints.
 * The active network is the deployment: developer mode is testnet, otherwise mainnet.
 */

import { Networks } from '@stellar/stellar-sdk'

import type { Network } from '@latch/types'

export type StellarNetworkId = Network

const STORAGE_KEY_NETWORK = 'latch.network'

const DEFAULT_HORIZON: Record<Network, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
}

const DEFAULT_SOROBAN_RPC: Record<Network, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://mainnet.sorobanrpc.com',
}

/** Build-time default when storage has no latch.network yet. */
export function getStellarNetworkFromEnv(): StellarNetworkId {
  const n = process.env.PLASMO_PUBLIC_STELLAR_NETWORK
  return n === 'mainnet' ? 'mainnet' : 'testnet'
}

export function networkPassphraseFor(network: Network): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
}

export function horizonUrlFor(network: Network): string {
  if (network === 'mainnet') {
    const raw = process.env.PLASMO_PUBLIC_HORIZON_MAINNET_URL
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
    return DEFAULT_HORIZON.mainnet
  }
  const raw = process.env.PLASMO_PUBLIC_HORIZON_URL
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return DEFAULT_HORIZON.testnet
}

export function sorobanRpcUrlFor(network: Network): string {
  if (network === 'mainnet') {
    const raw = process.env.PLASMO_PUBLIC_SOROBAN_RPC_MAINNET_URL
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
    return DEFAULT_SOROBAN_RPC.mainnet
  }
  const raw = process.env.PLASMO_PUBLIC_SOROBAN_RPC_URL
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return DEFAULT_SOROBAN_RPC.testnet
}

export function stellarExpertNetworkPath(network: Network): 'testnet' | 'public' {
  return network === 'mainnet' ? 'public' : 'testnet'
}

export function networkLabelFor(network: Network): string {
  return network === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet'
}

/** @deprecated Prefer getActiveNetwork(); kept for sync call sites during migration. */
export function networkPassphraseFromEnv(): string {
  return networkPassphraseFor(getStellarNetworkFromEnv())
}

/** @deprecated Prefer horizonUrlFor(await getActiveNetwork()). */
export function horizonUrlFromEnv(): string {
  return horizonUrlFor(getStellarNetworkFromEnv())
}

/** @deprecated Prefer sorobanRpcUrlFor(await getActiveNetwork()). */
export function sorobanRpcUrlFromEnv(): string {
  return sorobanRpcUrlFor(getStellarNetworkFromEnv())
}

/** @deprecated Prefer getActiveNetwork(). */
export function getActiveNetworkFromEnv(): Network {
  return getStellarNetworkFromEnv()
}

let cachedActiveNetwork: Network | null = null

export function peekCachedActiveNetwork(): Network | null {
  return cachedActiveNetwork
}

export function setCachedActiveNetwork(network: Network): void {
  cachedActiveNetwork = network
}

export async function getActiveNetwork(): Promise<Network> {
  const res = await chrome.storage.local.get(['latch.developerMode'])
  const network: Network = res['latch.developerMode'] === true ? 'testnet' : 'mainnet'
  cachedActiveNetwork = network
  return network
}

export async function setActiveNetwork(network: Network): Promise<Network> {
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`Invalid network: ${String(network)}`)
  }
  await chrome.storage.local.set({ [STORAGE_KEY_NETWORK]: network })
  cachedActiveNetwork = network
  return network
}

/** Test/helper: clear in-memory network cache so the next read hits storage/env. */
export function clearCachedActiveNetwork(): void {
  cachedActiveNetwork = null
}

export async function getNetworkConfig(): Promise<{
  network: Network
  networkPassphrase: string
  horizonUrl: string
  sorobanRpcUrl: string
  explorerNetwork: 'testnet' | 'public'
  networkLabel: string
}> {
  const network = await getActiveNetwork()
  return {
    network,
    networkPassphrase: networkPassphraseFor(network),
    horizonUrl: horizonUrlFor(network),
    sorobanRpcUrl: sorobanRpcUrlFor(network),
    explorerNetwork: stellarExpertNetworkPath(network),
    networkLabel: networkLabelFor(network),
  }
}

export function networkStorageKey(): string {
  return STORAGE_KEY_NETWORK
}
