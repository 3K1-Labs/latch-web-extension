import type { Network, StoredAccount } from '@latch/types'

import { getActiveNetwork } from '../network/config'
import { getAccountsForNetwork, patchAccountSmartAccountAddress } from '../storage'

/**
 * Empty factory wallet accidentally saved over the funded C-address during mid-send
 * create-or-connect. Map factory → funded address for restore.
 */
const FACTORY_TO_FUNDED: Record<string, string> = {
  CCATLEKRXNV7OXJ2OD3BHFVAZG4A2KRS6VPSD7BO6KTBL6YHX5MESRJ5:
    'CCMC7L43YL4AVKNWWQJGY6PD2ZL6N2KKGVVWZ7GMLNZM2NYB7YMLY7ET',
}

const DISPLACEMENT_STORAGE_KEY = 'latch.passkeyAddressDisplacement.v1'

type DisplacementRecord = {
  previousAddress: string
  factoryAddress: string
  updatedAtMs: number
}

type DisplacementMap = Record<string, DisplacementRecord>

async function readDisplacementMap(): Promise<DisplacementMap> {
  try {
    const res = await chrome.storage.local.get([DISPLACEMENT_STORAGE_KEY])
    const raw = res[DISPLACEMENT_STORAGE_KEY]
    if (!raw || typeof raw !== 'object') return {}
    return raw as DisplacementMap
  } catch {
    return {}
  }
}

async function writeDisplacementMap(map: DisplacementMap): Promise<void> {
  await chrome.storage.local.set({ [DISPLACEMENT_STORAGE_KEY]: map })
}

/** Record that create-or-connect tried to replace a funded C-address with a new factory address. */
export async function recordPasskeyAddressDisplacement(args: {
  credentialId?: string
  previousAddress: string
  factoryAddress: string
}): Promise<void> {
  const previousAddress = args.previousAddress.trim()
  const factoryAddress = args.factoryAddress.trim()
  if (!previousAddress || !factoryAddress || previousAddress === factoryAddress) return

  const map = await readDisplacementMap()
  const key = args.credentialId?.trim() || `addr:${previousAddress}`
  const rec: DisplacementRecord = {
    previousAddress,
    factoryAddress,
    updatedAtMs: Date.now(),
  }
  map[key] = rec
  map[`factory:${factoryAddress}`] = rec
  await writeDisplacementMap(map)
}

function fundedForFactory(factoryAddress: string, map: DisplacementMap): string | undefined {
  const known = FACTORY_TO_FUNDED[factoryAddress]
  if (known) return known
  const byFactory = map[`factory:${factoryAddress}`]?.previousAddress?.trim()
  if (byFactory) return byFactory
  for (const rec of Object.values(map)) {
    if (rec.factoryAddress === factoryAddress && rec.previousAddress?.trim()) {
      return rec.previousAddress.trim()
    }
  }
  return undefined
}

/**
 * Patch any local passkey account still pointing at a displaced factory C-address.
 * Scans both network buckets so repair works regardless of which network is active.
 * Returns accounts for the active network after repair.
 */
export async function repairDisplacedPasskeySmartAccountAddresses(): Promise<{
  accounts: StoredAccount[]
  repairedCount: number
}> {
  const map = await readDisplacementMap()
  let mapChanged = false
  for (const [factory, funded] of Object.entries(FACTORY_TO_FUNDED)) {
    if (!map[`factory:${factory}`]) {
      map[`factory:${factory}`] = {
        previousAddress: funded,
        factoryAddress: factory,
        updatedAtMs: 0,
      }
      mapChanged = true
    }
  }
  if (mapChanged) await writeDisplacementMap(map)

  let repairedCount = 0
  const networks: Network[] = ['testnet', 'mainnet']

  for (const network of networks) {
    const bucket = await getAccountsForNetwork(network)
    for (const acc of bucket.accounts) {
      if (acc.mode !== 'passkey') continue
      const current = acc.smartAccountAddress?.trim() ?? ''
      if (!current) continue
      const funded = fundedForFactory(current, map)
      if (!funded || funded === current) continue
      const patched = await patchAccountSmartAccountAddress({
        network,
        accountId: acc.id,
        smartAccountAddress: funded,
      })
      if (patched && patched.smartAccountAddress === funded) repairedCount += 1
    }
  }

  const active = await getActiveNetwork()
  const { accounts } = await getAccountsForNetwork(active)
  return { accounts, repairedCount }
}
