import type {
  NetworkFee,
  PrepareSwapTxResponse,
  SetupSwapRulesRequest,
  StoredAccount,
  SubmitTxResponse,
  SwapQuotePayload,
} from '@latch/types'

import { AQUARIUS_CONFIG, SOROSWAP_CONFIG } from '@latch/swap'

import { BackendError } from '../backend'
import { getActiveNetwork } from '../network/config'
import { getAccounts } from '../storage'
import { runPrepareSwapTx } from '../swap/handlers'
import {
  contextSetupKey,
  ensureSwapRulesConfigured,
  withInflightContextSetup,
} from '../tx/ensureContextRules'
import { signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'
import { webauthnVerifierAddressFromEnv } from '../../ui/lib/latchEnv'
import {
  isNoContextRuleError,
  isPrepareSignMissingSetupError,
  isSwapRuleReconfigureError,
  passkeySetupPrerequisiteError,
} from '../../ui/lib/sendTx'
import { swapBuildNeedsSignerReconfigure } from '../../ui/lib/swapTx'
import { networkFeeChanged, networkFeeEquals } from '../../ui/lib/networkFee'
import { isReviewAgainError, reviewAgainError } from './reviewAgain'
import { reviewedSwapBody, takeReviewedBuild } from './reviewedBuildStore'

function accountToSignerType(mode: StoredAccount['mode']): 'passkey' | 'delegated' {
  if (mode === 'passkey' || mode === 'multisig') return 'passkey'
  return 'delegated'
}

function resolveSwapRouterContractId(
  quote: SwapQuotePayload,
  network: 'testnet' | 'mainnet'
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

async function buildSetupSwapRequestFromQuote(
  quote: SwapQuotePayload,
  account: StoredAccount
): Promise<SetupSwapRulesRequest | null> {
  if (!account.smartAccountAddress) return null
  const network = await getActiveNetwork()
  const routerContractId = resolveSwapRouterContractId(quote, network)
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

function errShape(e: unknown): { code?: string; status?: number; message?: string } {
  if (e instanceof BackendError) {
    return { code: e.code, status: e.status, message: e.message }
  }
  if (e instanceof Error) return { message: e.message }
  return { message: String(e) }
}

export async function executeSwapConfirmInBackground(args: {
  accountId: string
  quote: SwapQuotePayload
  /** Fee shown on confirm. */
  shownNetworkFee?: NetworkFee | null
  /**
   * The user reviewed a prepare for exactly this quote. The background holds that prepare; it is
   * signed as-is while valid, and never rebuilt behind the user's back.
   */
  reviewed?: boolean
}): Promise<{ prepared: PrepareSwapTxResponse; submit: SubmitTxResponse }> {
  const { accounts } = await getAccounts()
  const activeAccount = accounts.find((a) => a.id === args.accountId)
  if (!activeAccount) throw new Error('No active account')

  const quoteForTx = args.quote
  const isSoroswap = quoteForTx.providerId === 'soroswap'

  async function runSwapRuleSetup(): Promise<void> {
    await setupSwapRulesForAccount(activeAccount!, quoteForTx)
  }

  if (args.reviewed) {
    // Missing, expired, priced differently, or needing new rules: sign nothing, show it again.
    const prepared = await takeReviewedBuild<PrepareSwapTxResponse>(
      'swap',
      reviewedSwapBody(args.accountId, quoteForTx)
    )
    if (!prepared) {
      console.warn('[latch:background] no held swap build for this quote; asking to review again')
      throw reviewAgainError('out_of_date')
    }
    if (!networkFeeEquals(args.shownNetworkFee, prepared.networkFee)) {
      throw reviewAgainError('fee_changed')
    }
    if (swapBuildNeedsSignerReconfigure(prepared, activeAccount)) {
      throw reviewAgainError('setup_needed')
    }
    try {
      const submit = await signAndSubmitBuiltTxInBackground({
        build: prepared,
        activeAccount,
      })
      return { prepared, submit }
    } catch (e) {
      // Rules went missing since review: back to confirm, which sets them up and re-prices.
      // Signing does not build, so a generic 400 here is a real failure, not a setup signal.
      const shape = errShape(e)
      if (isNoContextRuleError(shape) || isSwapRuleReconfigureError(shape)) {
        throw reviewAgainError('setup_needed')
      }
      throw e
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const prepared = await runPrepareSwapTx({
        accountId: activeAccount.id,
        quote: quoteForTx,
      })
      if (swapBuildNeedsSignerReconfigure(prepared, activeAccount)) {
        await runSwapRuleSetup()
        continue
      }
      // Backstop for a rebuild with no reviewed build: never sign a fee the user didn't see.
      if (networkFeeChanged(args.shownNetworkFee, prepared.networkFee)) {
        throw reviewAgainError('fee_changed')
      }
      const submit = await signAndSubmitBuiltTxInBackground({
        build: prepared,
        activeAccount,
      })
      return { prepared, submit }
    } catch (e) {
      if (isReviewAgainError(e)) throw e
      const shape = errShape(e)
      if (isNoContextRuleError(shape) || isSwapRuleReconfigureError(shape)) {
        await runSwapRuleSetup()
        continue
      }
      if (isSoroswap && isPrepareSignMissingSetupError(shape) && attempt < 4) {
        await runSwapRuleSetup()
        continue
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  throw new Error('Swap setup did not complete')
}

/** One-time swap-rule setup for this quote's router. */
export async function setupSwapRulesForAccount(
  account: StoredAccount,
  quote: SwapQuotePayload
): Promise<'configured' | 'already_configured'> {
  const setupBody = await buildSetupSwapRequestFromQuote(quote, account)
  if (!setupBody) {
    throw new Error(passkeySetupPrerequisiteError(account) ?? 'Invalid swap setup details')
  }
  // Coalesced: a re-fired prepare must not open a second passkey ceremony for the same rules.
  const key = contextSetupKey({
    network: setupBody.network ?? '',
    smartAccountAddress: setupBody.smartAccountAddress,
    kind: 'swap',
    target: setupBody.routerContractId ?? setupBody.providerId ?? 'default',
  })
  return withInflightContextSetup(key, () =>
    ensureSwapRulesConfigured({ setupBody, activeAccount: account })
  )
}

/** Same, by account id: run before Confirm enables. */
export async function setupSwapRulesInBackground(args: {
  accountId: string
  quote: SwapQuotePayload
}): Promise<'configured' | 'already_configured'> {
  const { accounts } = await getAccounts()
  const account = accounts.find((a) => a.id === args.accountId)
  if (!account) throw new Error('No active account')
  return setupSwapRulesForAccount(account, args.quote)
}
