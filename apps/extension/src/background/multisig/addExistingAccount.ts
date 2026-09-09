/**
 * "Add existing MultiSig": let a user re-attach a wallet they already co-own
 * after a reinstall or on a new machine.
 *
 * Membership is proven before anything is written locally, so a leftover API
 * session cannot be used to attach a wallet this install cannot sign for.
 * Two proofs are accepted, cheapest first:
 *
 * 1. The backend already lists the wallet with a member row matching a local
 *    signer (passkey credential id / key data, or a seed account's G-address).
 * 2. Otherwise a read-only on-chain read of the Default context rule shows one
 *    of this install's keys in the signer set.
 *
 * Adding grants no authority: spending still needs threshold approvals.
 */

import { StrKey } from '@stellar/stellar-sdk'
import type { AddExistingMultisigAccountResponse, StoredAccount } from '@latch/types'

import { listMultisigAccounts } from '../backend'
import { networkPassphraseFromEnv, sorobanRpcUrlFromEnv } from '../network/config'
import {
  createMultisigAccount,
  getAccounts,
  removeRemovedAccountAddress,
  setActiveAccount,
} from '../storage'
import { fetchDefaultContextRule, type ChainSigner } from './onchainSigners'
import {
  localSignerAccounts,
  normalizeListMultisigAccountsResponse,
  remoteMultisigMatchesLocalSigner,
  resolveRemoteMemberId,
} from './syncHelpers'

/** Ed25519 public key hex for a seed account, derived from its G-address. */
function ed25519HexFromGAddress(gAddress: string): string | undefined {
  try {
    const raw = StrKey.decodeEd25519PublicKey(gAddress.trim())
    let out = ''
    for (const b of raw) out += b.toString(16).padStart(2, '0')
    return out
  } catch {
    return undefined
  }
}

/**
 * True when the on-chain signer set contains key material this install holds.
 * WebAuthn key data embeds the credential id, so an exact match is required;
 * seed accounts match on their raw ed25519 public key or a delegated address.
 */
export function chainSignersIncludeLocalSigner(
  signers: ChainSigner[],
  localAccounts: StoredAccount[]
): boolean {
  const mine = localSignerAccounts(localAccounts)
  if (mine.length === 0 || signers.length === 0) return false

  const keyHexes = new Set<string>()
  const addresses = new Set<string>()
  for (const account of mine) {
    const passkeyHex = account.passkeyKeyDataHex?.trim().toLowerCase()
    if (passkeyHex) keyHexes.add(passkeyHex)

    const gAddress = account.gAddress?.trim()
    if (gAddress) {
      addresses.add(gAddress)
      const ed25519Hex = ed25519HexFromGAddress(gAddress)
      if (ed25519Hex) keyHexes.add(ed25519Hex)
    }

    const smart = account.smartAccountAddress?.trim()
    if (smart) addresses.add(smart)
  }

  return signers.some((signer) => {
    if (signer.kind === 'external') return keyHexes.has(signer.keyDataHex.toLowerCase())
    return addresses.has(signer.address)
  })
}

export class AddExistingMultisigError extends Error {}

export async function addExistingMultisigAccount(args: {
  smartAccountAddress: string
  label?: string
}): Promise<AddExistingMultisigAccountResponse> {
  const address = args.smartAccountAddress.trim()
  if (!StrKey.isValidContract(address)) {
    throw new AddExistingMultisigError('Enter a valid MultiSig wallet address (it starts with C).')
  }

  const { accounts } = await getAccounts()
  if (accounts.some((a) => a.smartAccountAddress?.trim() === address)) {
    throw new AddExistingMultisigError('This wallet is already in your accounts.')
  }
  if (localSignerAccounts(accounts).length === 0) {
    throw new AddExistingMultisigError(
      'Set up or sign in to a Latch account on this device first, so we can check that you co-own this wallet.'
    )
  }

  let verifiedVia: 'backend' | 'onchain' | undefined
  let threshold: number | undefined
  let memberId: string | undefined
  let backendAccountId: string | undefined
  let remoteLabel: string | undefined

  try {
    const listed = normalizeListMultisigAccountsResponse(await listMultisigAccounts())
    const remote = listed.find((a) => a.smartAccountAddress?.trim() === address)
    if (remote && remoteMultisigMatchesLocalSigner(remote, accounts)) {
      verifiedVia = 'backend'
      threshold = remote.threshold
      memberId = resolveRemoteMemberId(remote, accounts)
      backendAccountId = typeof remote.id === 'string' ? remote.id : undefined
      remoteLabel = remote.label?.trim()
    }
  } catch {
    // Backend unreachable or no session: fall through to the on-chain read.
  }

  if (!verifiedVia) {
    let rule
    try {
      rule = await fetchDefaultContextRule({
        rpcUrl: sorobanRpcUrlFromEnv(),
        networkPassphrase: networkPassphraseFromEnv(),
        accountAddress: address,
      })
    } catch {
      throw new AddExistingMultisigError(
        "We couldn't read that wallet on-chain. Check the address and your connection, then try again."
      )
    }

    if (rule.signers.length < 2) {
      throw new AddExistingMultisigError(
        'That address is a single-signer account, not a MultiSig wallet.'
      )
    }
    if (!chainSignersIncludeLocalSigner(rule.signers, accounts)) {
      throw new AddExistingMultisigError(
        "This device isn't a signer on that MultiSig wallet, so it can't be added."
      )
    }
    verifiedVia = 'onchain'
    threshold = rule.signers.length
  }

  const label = args.label?.trim() || remoteLabel || 'Multisig wallet'
  const { account, activeAccountId } = await createMultisigAccount({
    smartAccountAddress: address,
    label,
    multisigThreshold: threshold,
    multisigMemberId: memberId,
    multisigBackendAccountId: backendAccountId,
  })

  // An earlier removal must not block an explicit re-add.
  await removeRemovedAccountAddress(address)

  // No backend register call here: `POST /api/multisig/accounts/register`
  // needs the account salt and the full member list, which an on-chain-verified
  // add does not have. Re-linking membership to the session is a backend
  // concern — see LATCH_BACKEND_ACCOUNT_IDENTITY.md. Proposals still resolve
  // once the member row is linked by credential id at login.

  if (!activeAccountId) {
    await setActiveAccount(account.id)
  }

  return { account, activeAccountId: activeAccountId ?? account.id, verifiedVia }
}
