import type {
  BuildSendTxResponse,
  Network,
  SetupSwapRulesRequest,
  StoredAccount,
  SwapQuotePayload,
} from '@latch/types'

import { AQUARIUS_CONFIG, SOROSWAP_CONFIG } from '@latch/swap'

import { fetchActiveNetwork } from './activeNetwork'
import { webauthnVerifierAddressFromEnv } from './latchEnv'
import { accountToSignerType, isDelegatedSendBuild, passkeySetupPrerequisiteError } from './sendTx'

export function resolveSwapRouterContractId(
  quote: SwapQuotePayload,
  network: Network
): string | null {
  const payload = quote.buildPayload as { routerContractId?: string; kind?: string }
  if (payload.routerContractId?.startsWith('C')) return payload.routerContractId

  if (quote.providerId === 'aquarius' || payload.kind === 'aquarius') {
    return AQUARIUS_CONFIG[network].routerContractId
  }

  if (quote.providerId === 'soroswap' || payload.kind === 'soroswap') {
    return SOROSWAP_CONFIG[network].routerContractId
  }

  return null
}

export async function buildSetupSwapRequestFromQuote(
  quote: SwapQuotePayload,
  account: StoredAccount
): Promise<SetupSwapRulesRequest | null> {
  if (!account.smartAccountAddress) return null

  const { network } = await fetchActiveNetwork()
  const routerContractId = resolveSwapRouterContractId(quote, network)
  // Aquarius needs an explicit router target. Soroswap / Default-rule backends
  // accept optional routerContractId; still send it when known.
  if (quote.providerId === 'aquarius' && !routerContractId) return null

  const signerType = accountToSignerType(account.mode)
  const req: SetupSwapRulesRequest = {
    smartAccountAddress: account.smartAccountAddress,
    signerType,
    network,
    providerId: quote.providerId,
  }
  if (routerContractId) req.routerContractId = routerContractId

  if (signerType === 'passkey') {
    const keyDataHex = account.passkeyKeyDataHex?.trim()
    if (!keyDataHex) return null
    req.keyDataHex = keyDataHex
    // Backend owns the verifier (Swagger omits it); send when configured for
    // backwards compatibility — same as setup-send-rules. Do not block swap
    // confirm when PLASMO_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS[_MAINNET] is unset.
    const verifierAddress = webauthnVerifierAddressFromEnv(network)
    if (verifierAddress) req.verifierAddress = verifierAddress
    if (account.passkeyCredentialId?.trim()) {
      req.credentialId = account.passkeyCredentialId.trim()
    }
  }
  if (signerType === 'delegated') {
    if (!account.gAddress?.trim()) return null
    req.gAddress = account.gAddress
  }

  return req
}

export async function swapSetupPrerequisiteError(
  account: StoredAccount,
  quote: SwapQuotePayload
): Promise<string | null> {
  const passkeyErr = passkeySetupPrerequisiteError(account)
  if (passkeyErr) return passkeyErr
  const signerType = accountToSignerType(account.mode)
  if (signerType === 'delegated' && !account.gAddress?.trim()) {
    return 'Missing G-address for this account. Re-import the wallet in Settings.'
  }
  const { network } = await fetchActiveNetwork()
  if (quote.providerId === 'aquarius' && !resolveSwapRouterContractId(quote, network)) {
    return 'Swap router is not configured for this provider.'
  }
  return null
}

/** True when API built a bundler-only swap auth path but the user signs with passkey. */
export function swapBuildNeedsSignerReconfigure(
  build: BuildSendTxResponse,
  account: StoredAccount
): boolean {
  const signerType = accountToSignerType(account.mode)

  if (
    signerType === 'delegated' &&
    (build.submitMethod === 'delegated' || build.submitMethod === 'bundler-delegated') &&
    isDelegatedSendBuild(build)
  ) {
    return false
  }

  if (signerType !== 'passkey') return false

  const submitMethod = build.submitMethod
  if (submitMethod === 'bundler-delegated') return true

  // Older APIs may omit submitMethod while still prefilling Delegated(bundler) on the smart-account entry.
  if (
    build.smartAccountAuthEntryXdr &&
    !build.gAddressEntryTemplateXdr &&
    build.delegatedGAuthEntrySynthesized === true
  ) {
    return true
  }

  return false
}
