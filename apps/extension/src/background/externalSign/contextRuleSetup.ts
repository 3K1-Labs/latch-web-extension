/**
 * Decide which one-time context-rule setup a dapp-supplied unsigned XDR needs.
 *
 * Latch only knows how to add rules for two shapes: a catalog SAC transfer
 * (setup-send-rules, per asset) and a known swap router (setup-swap-rules, on
 * the default rule). Anything else fails closed — we never blanket-configure
 * the whole catalog on behalf of a website.
 */

import { buildSacAssetInfoMap, parseTxForReview, stellarAddressEquals } from '@latch/stellar'
import { AQUARIUS_CONFIG, SOROSWAP_CONFIG } from '@latch/swap'
import type {
  Network,
  SetupSendRulesRequest,
  SetupSwapRulesRequest,
  StoredAccount,
} from '@latch/types'

import { BackendError } from '../backend'
import { networkPassphraseFor } from '../network/config'
import { accountToSignerType, passkeySetupPrerequisiteError } from '../../ui/lib/sendTx'
import { webauthnVerifierAddressFromEnv } from '../../ui/lib/latchEnv'

export type ExternalSignContextSetup =
  | { kind: 'send'; target: string; body: SetupSendRulesRequest }
  | { kind: 'swap'; target: string; body: SetupSwapRulesRequest }

export const CONTEXT_RULE_SETUP_UNSUPPORTED = 'context_rule_setup_unsupported'

function unsupported(message: string): BackendError {
  return new BackendError(message, { status: 400, code: CONTEXT_RULE_SETUP_UNSUPPORTED })
}

function applySignerFields(
  req: SetupSendRulesRequest | SetupSwapRulesRequest,
  account: StoredAccount,
  network: Network
): void {
  if (req.signerType === 'passkey') {
    const keyDataHex = account.passkeyKeyDataHex?.trim()
    if (!keyDataHex) {
      throw new BackendError(
        passkeySetupPrerequisiteError(account) ??
          'Missing passkey key data for this account. Log out and sign in with your passkey again.',
        { status: 400, code: 'context_rule_setup_failed' }
      )
    }
    req.keyDataHex = keyDataHex
    // Optional on the current API, still sent when configured for compatibility.
    const verifierAddress = webauthnVerifierAddressFromEnv(network)
    if (verifierAddress) req.verifierAddress = verifierAddress
    const credentialId = account.passkeyCredentialId?.trim()
    if (credentialId) req.credentialId = credentialId
    return
  }

  const gAddress = account.gAddress?.trim()
  if (!gAddress) {
    throw new BackendError(
      'This account has no signing address available for context-rule setup.',
      { status: 400, code: 'context_rule_setup_failed' }
    )
  }
  req.gAddress = gAddress
}

function swapProviderForContract(
  contractId: string,
  network: Network
): { providerId: string; routerContractId: string } | null {
  const soroswap = SOROSWAP_CONFIG[network]
  if (
    stellarAddressEquals(contractId, soroswap.routerContractId) ||
    stellarAddressEquals(contractId, soroswap.ammRouterContractId)
  ) {
    return { providerId: 'soroswap', routerContractId: soroswap.routerContractId }
  }
  const aquarius = AQUARIUS_CONFIG[network]
  if (stellarAddressEquals(contractId, aquarius.routerContractId)) {
    return { providerId: 'aquarius', routerContractId: aquarius.routerContractId }
  }
  return null
}

/**
 * Throws a `BackendError` when the transaction is not a shape Latch can set
 * rules up for, or when the account lacks the signer data setup needs.
 */
export function resolveExternalSignContextSetup(args: {
  unsignedTxXdr: string
  network: Network
  account: StoredAccount
}): ExternalSignContextSetup {
  const { account, network } = args
  if (!account.smartAccountAddress) {
    throw unsupported('No smart account is selected.')
  }

  let parsed
  try {
    parsed = parseTxForReview(args.unsignedTxXdr, networkPassphraseFor(network))
  } catch {
    throw unsupported('Could not read this transaction to set up account permissions.')
  }

  const signerType = accountToSignerType(account.mode)

  for (const contractId of parsed.invokeContractIds) {
    const provider = swapProviderForContract(contractId, network)
    if (!provider) continue
    const body: SetupSwapRulesRequest = {
      smartAccountAddress: account.smartAccountAddress,
      signerType,
      network,
      providerId: provider.providerId,
      routerContractId: provider.routerContractId,
    }
    applySignerFields(body, account, network)
    return { kind: 'swap', target: provider.routerContractId, body }
  }

  const transferOp = parsed.operations.find((op) => op.type === 'sac_transfer')
  const transferContract = transferOp?.details?.contract
  if (transferOp && transferContract) {
    const assetByContract = buildSacAssetInfoMap({
      networkPassphrase: networkPassphraseFor(network),
      network,
    })
    const asset = assetByContract.get(transferContract)
    if (asset) {
      // Always name the asset: an empty assetId tells the API to configure the
      // entire catalog, which is far more than this request asked for.
      const body: SetupSendRulesRequest = {
        smartAccountAddress: account.smartAccountAddress,
        signerType,
        network,
        assetId: asset.assetType === 'native' ? 'native' : asset.code,
      }
      applySignerFields(body, account, network)
      return { kind: 'send', target: body.assetId!, body }
    }
  }

  throw unsupported(
    'Latch cannot set up account permissions for this transaction automatically. ' +
      'Send this asset or run this swap from the wallet once, then try again.'
  )
}
