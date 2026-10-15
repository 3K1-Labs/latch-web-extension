import type { CosignWalletRecord, StoredAccount } from '@latch/types'

import { loadSmartAccountPortfolioRows } from '@latch/stellar'

import { announceMembership, listMemberships } from '../api/cosign/memberships'
import { getWCKBundle, storeWCKBundle } from '../api/cosign/wckBundles'
import {
  getActiveNetwork,
  horizonUrlFor,
  networkPassphraseFor,
  sorobanRpcUrlFor,
} from '../network/config'
import { getAccounts, upsertAccount } from '../storage'
import {
  deriveBlindSignerId,
  deriveMemberBlindId,
  derivePickupKey,
  fromBase64,
  fromHex,
  sealWCKBundle,
  toHex,
  unsealWCKBundle,
} from './crypto'
import { ensureDeviceTransportKeyPair } from './keyStorage'
import { signerPublicKeyBytesForAccount } from './signerBytes'
import {
  getCosignWalletRecordByAddress,
  listCosignWalletRecords,
  newCosignWalletRecordId,
  saveCosignWalletRecord,
  wckBytesFromRecord,
} from './wckStorage'

async function verifyOnChainMembership(walletRef: string): Promise<boolean> {
  try {
    const network = await getActiveNetwork()
    await loadSmartAccountPortfolioRows({
      rpcUrl: sorobanRpcUrlFor(network),
      networkPassphrase: networkPassphraseFor(network),
      network,
      cAddress: walletRef,
      horizonUrl: horizonUrlFor(network),
      signal: AbortSignal.timeout(10_000),
    })
    return true
  } catch {
    return false
  }
}

export async function discoverMembershipsForAccount(
  linkedAccount: StoredAccount
): Promise<{ discovered: CosignWalletRecord[]; accounts: StoredAccount[] }> {
  const signerBytes = await signerPublicKeyBytesForAccount(linkedAccount)
  const memberBlindId = await deriveMemberBlindId(signerBytes)
  const authWallet = linkedAccount.smartAccountAddress

  const announced = await listMemberships(authWallet, memberBlindId)
  const knownRecords = await listCosignWalletRecords()
  const knownRefs = new Set(knownRecords.map((r) => r.walletRef))
  const { accounts } = await getAccounts()
  const discovered: CosignWalletRecord[] = []

  const transport = await ensureDeviceTransportKeyPair()

  for (const { wallet_ref: walletRef } of announced) {
    if (knownRefs.has(walletRef)) continue
    if (accounts.some((a) => a.mode === 'multisig' && a.smartAccountAddress === walletRef)) {
      continue
    }

    const onChain = await verifyOnChainMembership(walletRef)
    if (!onChain) continue

    const pickupKey = await derivePickupKey(walletRef)
    const bundleJson = await getWCKBundle(authWallet, pickupKey)
    const wckBytes = await unsealWCKBundle(bundleJson, transport.privateKey)

    const record: CosignWalletRecord = {
      id: newCosignWalletRecordId(),
      walletRef,
      wckHex: toHex(wckBytes),
      threshold: 2,
      label: 'Shared wallet',
      linkedSignerAccountId: linkedAccount.id,
      createdAt: Date.now(),
    }
    await saveCosignWalletRecord(record)
    discovered.push(record)
    knownRefs.add(walletRef)
  }

  const nextAccounts = [...accounts]
  for (const record of discovered) {
    const blindSignerId = await deriveBlindSignerId(wckBytesFromRecord(record), signerBytes)
    const { account } = await upsertAccount({
      mode: 'multisig',
      smartAccountAddress: record.walletRef,
      label: record.label,
      multisigThreshold: record.threshold,
      cosignWckRefId: record.id,
      cosignBlindSignerId: blindSignerId,
      cosignLinkedAccountId: linkedAccount.id,
      multisigAccountSaltHex: record.accountSaltHex,
      multisigMembersSnapshot: record.membersSnapshot,
    })
    const idx = nextAccounts.findIndex((a) => a.id === account.id)
    if (idx >= 0) nextAccounts[idx] = account
    else nextAccounts.push(account)
  }

  return { discovered, accounts: nextAccounts }
}

export async function getCosignRecordForWallet(
  walletRef: string
): Promise<CosignWalletRecord | undefined> {
  return getCosignWalletRecordByAddress(walletRef)
}

export async function announceMemberForWallet(args: {
  walletRef: string
  wckHex: string
  memberBlindIds: string[]
  transportPubkeyB64: string
}): Promise<void> {
  const wck = fromHex(args.wckHex)
  const pickupKey = await derivePickupKey(args.walletRef)
  const sealed = await sealWCKBundle(wck, fromBase64(args.transportPubkeyB64))
  await announceMembership(args.walletRef, {
    wallet_ref: args.walletRef,
    member_blind_ids: args.memberBlindIds,
  })
  await storeWCKBundle(args.walletRef, pickupKey, sealed)
}
