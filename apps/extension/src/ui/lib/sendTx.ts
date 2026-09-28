import { Asset, Networks } from '@stellar/stellar-sdk'
import {
  fetchHorizonAccountJson,
  isHorizonCreditBalance,
  parseHorizonAccountJson,
} from '@latch/stellar'
import type {
  AccountMode,
  BuildSendTxRequest,
  BuildSendTxResponse,
  Network,
  SendSignerType,
  SetupSendRulesRequest,
  SetupSendRulesResponse,
  SmartAccountBalanceRow,
  StoredAccount,
} from '@latch/types'

import { friendlyError, sendToBackground } from './backgroundClient'
import { fiatToCrypto } from './sendAmount'
import { isValidStellarGAddress } from './sendAddress'
import { webauthnVerifierAddressFromEnv } from './latchEnv'
import type { SendDraft } from '../types/send'

export function sendCryptoAmountFromDraft(
  draft: SendDraft,
  priceUsd: number | null
): string | null {
  if (!draft.token) return null
  if (draft.inputMode === 'crypto') {
    const trimmed = draft.amount.trim()
    return trimmed || null
  }
  return fiatToCrypto(draft.amount, priceUsd)
}

/** Why build-send cannot be assembled from the current draft (user-facing). */
export function explainSendDraftNotBuildable(
  draft: SendDraft,
  account: StoredAccount | null | undefined,
  priceUsd: number | null
): string | null {
  if (!account?.smartAccountAddress?.trim()) return 'No smart account is selected.'
  if (!draft.token) return 'Select a token to send.'
  if (!draft.recipientAddress.trim()) return 'Enter a recipient address.'
  if (draft.inputMode === 'fiat' && (priceUsd == null || priceUsd <= 0)) {
    return 'USD price is unavailable. Switch the amount to crypto and try again.'
  }
  if (!sendCryptoAmountFromDraft(draft, priceUsd)) return 'Enter a valid amount.'
  if (!draft.token.assetId && !draft.token.sacContractId?.trim()) {
    return 'This token is missing contract details. Refresh balances and try again.'
  }
  return null
}

export function accountToSignerType(mode: AccountMode): SendSignerType {
  // 'freighter' is the backend wire value for delegated G-signer builds (mnemonic accounts).
  if (mode === 'passkey' || mode === 'multisig') return 'passkey'
  return 'freighter'
}

export function buildSendRequestFromDraft(
  draft: SendDraft,
  account: StoredAccount,
  priceUsd: number | null,
  network: Network = 'testnet'
): BuildSendTxRequest | null {
  if (explainSendDraftNotBuildable(draft, account, priceUsd)) return null
  const amount = sendCryptoAmountFromDraft(draft, priceUsd)
  if (!amount || !draft.token) return null

  const signerType = accountToSignerType(account.mode)
  const req: BuildSendTxRequest = {
    smartAccountAddress: account.smartAccountAddress,
    signerType,
    recipient: draft.recipientAddress.trim(),
    amount,
    network,
  }

  const code = draft.token.code.toUpperCase()
  if (draft.token.assetId) {
    req.assetId = draft.token.assetId
  } else if (code === 'XLM' && !draft.token.issuer) {
    // Portfolio rows often omit catalog assetId; backend accepts `native`.
    req.assetId = 'native'
  } else {
    // Catalog ids match token codes (e.g. USDC). Prefer assetId so mainnet catalog lookup
    // does not depend solely on contractId.
    req.assetId = code
  }
  if (draft.token.sacContractId?.trim()) {
    req.contractId = draft.token.sacContractId.trim()
  }
  if (!req.assetId && !req.contractId) {
    return null
  }

  if (signerType === 'freighter' && account.gAddress) {
    req.signerG = account.gAddress
  }
  const keyDataHex = account.mode === 'passkey' ? account.passkeyKeyDataHex?.trim() : undefined
  if (keyDataHex) req.keyDataHex = keyDataHex

  return req
}
export function buildSetupRequestFromDraft(
  draft: SendDraft,
  account: StoredAccount,
  signingAccount?: StoredAccount,
  network: Network = 'testnet'
): SetupSendRulesRequest | null {
  if (!account.smartAccountAddress || !draft.token) return null
  const signerType = accountToSignerType(account.mode)
  const req: SetupSendRulesRequest = {
    smartAccountAddress: account.smartAccountAddress,
    signerType,
    network,
  }

  if (draft.token.assetId) {
    req.assetId = draft.token.assetId
  } else if (draft.token.code.toUpperCase() === 'XLM') {
    req.assetId = 'native'
  } else {
    req.assetId = draft.token.code
  }

  const passkeySource = account.mode === 'multisig' ? signingAccount : account

  if (signerType === 'passkey') {
    const keyDataHex = passkeySource?.passkeyKeyDataHex?.trim()
    if (!keyDataHex) return null
    req.keyDataHex = keyDataHex
    // Backend no longer requires verifierAddress to set up rules (Swagger omits it),
    // but keep sending it when configured for backwards compatibility.
    const verifierAddress = webauthnVerifierAddressFromEnv(network)
    if (verifierAddress) req.verifierAddress = verifierAddress
    const credentialId = passkeySource?.passkeyCredentialId?.trim()
    if (credentialId) {
      req.credentialId = credentialId
    }
  }
  if (signerType === 'freighter') {
    if (!account.gAddress?.trim()) return null
    req.gAddress = account.gAddress
  }

  return req
}

export function isNoContextRuleError(error?: { code?: string; status?: number }): boolean {
  return error?.status === 409 && error?.code === 'NO_CONTEXT_RULE'
}

/** Classic issued assets (USDC, etc.) need a G-recipient trustline; native XLM does not. */
export function tokenRequiresClassicTrustline(
  token: SmartAccountBalanceRow | null | undefined
): boolean {
  if (!token) return false
  const code = token.code.trim().toUpperCase()
  if (!code) return false
  if (code === 'XLM' && !token.issuer) return false
  if (token.assetId?.trim().toLowerCase() === 'native') return false
  return true
}

export function missingTrustlineSendMessage(symbol: string): string {
  const token = symbol.trim() || 'this token'
  return `This address can’t receive ${token} yet. They need to add a ${token} trustline in their wallet first.`
}

/** True when API/simulation text clearly indicates a missing recipient trustline. */
export function isMissingTrustlineErrorMessage(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('trustline entry is missing') ||
    m.includes('trustline is missing') ||
    m.includes('missing trustline') ||
    m.includes('no matching trustline') ||
    /\bno_trust(?:line)?\b/.test(m) ||
    /\bop_no_trust\b/.test(m) ||
    /\brecipient_no_trustline\b/.test(m)
  )
}

/** Opaque build-send failures (API often hides the on-chain reason). */
export function isOpaqueSendBuildFailureMessage(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('failed to build transaction') ||
    m.includes('failed to build') ||
    m === 'internal error' ||
    m === 'internal_error'
  )
}

function horizonUrlForSendUi(network: Network): string {
  if (network === 'mainnet') {
    const raw = process.env.PLASMO_PUBLIC_HORIZON_MAINNET_URL
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
    return 'https://horizon.stellar.org'
  }
  const raw = process.env.PLASMO_PUBLIC_HORIZON_URL
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return 'https://horizon-testnet.stellar.org'
}

function networkPassphraseForSendUi(network: Network): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
}

/**
 * Returns true when the G account has no trustline for this token.
 * Returns null when Horizon cannot answer (leave the original error alone).
 */
export async function recipientMissingClassicTrustline(params: {
  recipientG: string
  token: SmartAccountBalanceRow
  network: Network
  signal?: AbortSignal
}): Promise<boolean | null> {
  const code = params.token.code.trim()
  const issuer = params.token.issuer?.trim()
  const sac = params.token.sacContractId?.trim()
  if (!code && !sac) return null

  const horizonUrl = horizonUrlForSendUi(params.network)
  const passphrase = networkPassphraseForSendUi(params.network)
  try {
    const json = await fetchHorizonAccountJson(horizonUrl, params.recipientG.trim(), params.signal)
    const record = parseHorizonAccountJson(json)
    if (!record) return true

    const hasTrustline = record.balances.some((b) => {
      if (!isHorizonCreditBalance(b)) return false
      if (issuer) {
        return b.asset_code === code && b.asset_issuer === issuer
      }
      if (!sac) return b.asset_code.toUpperCase() === code.toUpperCase()
      try {
        return new Asset(b.asset_code, b.asset_issuer).contractId(passphrase) === sac
      } catch {
        return false
      }
    })
    return !hasTrustline
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Unfunded / unknown G accounts also cannot hold the asset yet.
    if (/\b404\b/.test(msg) || /not found/i.test(msg)) return true
    return null
  }
}

/**
 * Map raw send failures onto a clear trustline message when we can confirm the cause.
 * Failures that aren't trustline-related are returned unchanged.
 */
export async function enrichSendFailureDetail(params: {
  errorMessage: string
  draft: SendDraft
  network: Network
}): Promise<string> {
  const raw = params.errorMessage.trim()
  const symbol = params.draft.token?.code?.trim() || 'this token'

  if (isMissingTrustlineErrorMessage(raw)) {
    return missingTrustlineSendMessage(symbol)
  }

  const token = params.draft.token
  if (
    !token ||
    !tokenRequiresClassicTrustline(token) ||
    !isValidStellarGAddress(params.draft.recipientAddress) ||
    !isOpaqueSendBuildFailureMessage(raw)
  ) {
    return raw || params.errorMessage
  }

  const missing = await recipientMissingClassicTrustline({
    recipientG: params.draft.recipientAddress,
    token,
    network: params.network,
  })
  if (missing === true) return missingTrustlineSendMessage(symbol)
  return raw || params.errorMessage
}

/**
 * prepare-sign (unlike build-swap) often returns a generic 400 internal_error when the
 * smart account is missing swap context rules / not configured — see
 * prepare-sign-integration-guide.md. Treat that as a setup-retry signal for Soroswap.
 */
export function isPrepareSignMissingSetupError(error?: {
  code?: string
  status?: number
  message?: string
}): boolean {
  if (!error) return false
  if (error.status === 409 && error.code === 'NO_CONTEXT_RULE') return true
  if (error.status !== 400) return false
  const code = (error.code ?? '').toLowerCase()
  const message = (error.message ?? '').toLowerCase()
  return (
    code === 'internal_error' ||
    message.includes('failed to prepare') ||
    message.includes('prepare transaction')
  )
}

/**
 * build-send for a cataloged non-native asset (e.g. mainnet USDC) fails simulation when the
 * CallContract send context rule is missing. The API often returns opaque 400
 * `internal_error` / "failed to build transaction" instead of 409 `NO_CONTEXT_RULE`
 * (same hygiene as prepare-sign). Treat that as a setup-send-rules retry signal.
 */
export function isBuildSendMissingSetupError(error?: {
  code?: string
  status?: number
  message?: string
}): boolean {
  if (!error) return false
  if (isNoContextRuleError(error)) return true
  if (error.status !== 400) return false
  const code = (error.code ?? '').toLowerCase()
  const message = (error.message ?? '').toLowerCase()
  return (
    code === 'internal_error' ||
    message.includes('failed to build transaction') ||
    message.includes('failed to build')
  )
}

export type EnsureSendRulesResult = 'configured' | 'already_configured'

/**
 * Call setup-send-rules only when build-send reports missing context rules.
 * Not required on every send (testnet often already has rules after deploy).
 */
export async function ensureSendRulesConfigured(args: {
  setupBody: SetupSendRulesRequest
  signAndSubmit: (build: BuildSendTxResponse) => Promise<unknown>
  onProgress?: (label: string) => void
  maxAttempts?: number
}): Promise<EnsureSendRulesResult> {
  const maxAttempts = args.maxAttempts ?? 5
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    args.onProgress?.('Setting up…')
    const setupRes = await sendToBackground<SetupSendRulesRequest, SetupSendRulesResponse>({
      type: 'SETUP_SEND_RULES',
      payload: args.setupBody,
    })
    if (!setupRes.ok) throw new Error(friendlyError(setupRes.error))
    const setup = setupRes.data!
    if (setup.alreadyConfigured) return 'already_configured'
    await args.signAndSubmit(setup)
    if ((setup.remainingSetupCount ?? 0) <= 0) return 'configured'
  }
  throw new Error('Send setup did not complete')
}

export function isSignerMismatchError(error?: { code?: string; status?: number }): boolean {
  return error?.status === 409 && error?.code === 'SIGNER_MISMATCH'
}

export function isBundlerMismatchError(error?: { code?: string; status?: number }): boolean {
  return error?.status === 409 && error?.code === 'BUNDLER_MISMATCH'
}

/** On-chain rules need reconfiguration (wrong signer type or stale bundler G). */
export function isSwapRuleReconfigureError(error?: { code?: string; status?: number }): boolean {
  return isSignerMismatchError(error) || isBundlerMismatchError(error)
}

export {
  contextRuleIdForSubmit,
  contextRuleIdString,
  delegatedSubmitFields,
  isDelegatedSendBuild,
  multiAuthSubmitFields,
  normalizeDelegatedBuildFields,
  resolvePasskeyAuthEntryXdr,
} from '../../lib/sendBuildFields'

/** User-facing error when passkey setup payload cannot be built. */
export function passkeySetupPrerequisiteError(account: StoredAccount): string | null {
  if (accountToSignerType(account.mode) !== 'passkey') return null
  if (!account.passkeyKeyDataHex?.trim()) {
    return 'Missing passkey key data for this account. Log out and sign in with your passkey again.'
  }
  return null
}
