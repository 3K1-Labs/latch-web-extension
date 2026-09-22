import type {
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
import { ensureSwapRulesConfigured } from '../tx/ensureContextRules'
import { signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'
import { webauthnVerifierAddressFromEnv } from '../../ui/lib/latchEnv'
import {
  isNoContextRuleError,
  isPrepareSignMissingSetupError,
  isSwapRuleReconfigureError,
  passkeySetupPrerequisiteError,
} from '../../ui/lib/sendTx'
import { swapBuildNeedsSignerReconfigure } from '../../ui/lib/swapTx'

function accountToSignerType(mode: StoredAccount['mode']): 'passkey' | 'freighter' {
  if (mode === 'passkey' || mode === 'multisig') return 'passkey'
  return 'freighter'
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
  if (signerType === 'freighter') {
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
}): Promise<{ prepared: PrepareSwapTxResponse; submit: SubmitTxResponse }> {
  const { accounts } = await getAccounts()
  const activeAccount = accounts.find((a) => a.id === args.accountId)
  if (!activeAccount) throw new Error('No active account')

  const quoteForTx = args.quote
  const isSoroswap = quoteForTx.providerId === 'soroswap'

  async function runSwapRuleSetup(): Promise<void> {
    const setupPayload = await buildSetupSwapRequestFromQuote(quoteForTx, activeAccount!)
    if (!setupPayload) {
      throw new Error(passkeySetupPrerequisiteError(activeAccount!) ?? 'Invalid swap setup details')
    }

    await ensureSwapRulesConfigured({ setupBody: setupPayload, activeAccount: activeAccount! })
  }

  if (isSoroswap) {
    await runSwapRuleSetup()
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
      const submit = await signAndSubmitBuiltTxInBackground({
        build: prepared,
        activeAccount,
      })
      return { prepared, submit }
    } catch (e) {
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
