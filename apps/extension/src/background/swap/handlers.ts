import type {
  BackgroundMessage,
  BuildSwapTxRequest,
  GetSwapQuoteRequest,
  GetSwapQuoteResponse,
  GetSwapTokenCatalogRequest,
  GetSwapTokenCatalogResponse,
  PrepareSwapTxRequest,
  PrepareSwapTxResponse,
  SendSignerType,
  SetupSwapRulesRequest,
  SwapQuotePayload,
  SwapTokenRow,
  StoredAccount,
} from '@latch/types'

import {
  DEFAULT_SLIPPAGE_BPS,
  getActiveSwapProvider,
  humanToRaw,
  resolveSwapTransactionSourceG,
  type SwapAsset,
  type SwapQuote,
} from '@latch/swap'

import { BackendError, buildSwapTx, prepareSign, setupSwapRules } from '../backend'
import type { OkFn } from '../messageResponse'
import { withCancellableWaiter } from '../requestWaiter'
import { getActiveNetwork, networkPassphraseFor, sorobanRpcUrlFor } from '../network/config'
import { getAccounts } from '../storage'
import {
  findSwapToken,
  loadPayTokens,
  loadReceiveTokens,
  preferredReceiveTokenIds,
} from './catalog'
import { getOrCreateQuote, quoteCacheKey } from './quoteCache'

function accountModeToSignerType(account: StoredAccount): SendSignerType {
  // 'freighter' is the backend wire value for delegated G-signer builds (mnemonic accounts).
  return account.mode === 'passkey' ? 'passkey' : 'freighter'
}

function passkeyKeyDataHex(account: StoredAccount): string | undefined {
  return account.mode === 'passkey' ? account.passkeyKeyDataHex?.trim() || undefined : undefined
}

function aquariusBuildParams(
  payload: SwapQuotePayload,
  network: 'testnet' | 'mainnet'
): BuildSwapTxRequest | null {
  const bp = payload.buildPayload as {
    kind?: string
    swapChainXdr?: string
    routerContractId?: string
    tokenInContractId?: string
  }
  if (bp.kind !== 'aquarius' || !bp.swapChainXdr || !bp.routerContractId || !bp.tokenInContractId) {
    return null
  }
  return {
    network,
    smartAccountAddress: '',
    signerType: 'passkey',
    routerContractId: bp.routerContractId,
    swapChainXdr: bp.swapChainXdr,
    tokenInContractId: bp.tokenInContractId,
    amountInRaw: payload.amountInRaw,
    amountOutMinRaw: payload.amountOutMinRaw,
    providerId: payload.providerId,
  }
}

function swapTokenToAsset(token: SwapTokenRow): SwapAsset {
  return {
    assetId: token.assetId,
    symbol: token.symbol,
    contractId: token.contractId,
    decimals: token.decimals,
    issuer: token.issuer,
    name: token.name,
  }
}

function quoteToPayload(
  quote: SwapQuote,
  assetIn: SwapTokenRow,
  assetOut: SwapTokenRow,
  slippageBps: number
): SwapQuotePayload {
  return {
    providerId: quote.providerId,
    providerName: quote.providerName,
    amountInRaw: quote.amountInRaw,
    amountOutRaw: quote.amountOutRaw,
    amountOutMinRaw: quote.amountOutMinRaw,
    pathLabels: quote.pathLabels,
    pools: quote.pools,
    expiresAtMs: quote.expiresAtMs,
    slippageBps,
    assetIn,
    assetOut,
    buildPayload: quote.buildPayload as Record<string, unknown>,
  }
}

async function getActiveAccount(accountId: string): Promise<StoredAccount> {
  const { accounts } = await getAccounts()
  const account = accounts.find((a) => a.id === accountId)
  if (!account?.smartAccountAddress) {
    throw new BackendError('No active account', { status: 400, code: 'no_account' })
  }
  return account
}

export async function runGetSwapTokenCatalog(
  req: GetSwapTokenCatalogRequest
): Promise<GetSwapTokenCatalogResponse> {
  const network = await getActiveNetwork()
  const [payTokens, receiveTokens] = await Promise.all([
    loadPayTokens(req.accountId),
    loadReceiveTokens(req.accountId),
  ])
  return {
    payTokens,
    receiveTokens,
    preferredReceiveTokenIds: preferredReceiveTokenIds(network),
  }
}

export async function runGetSwapQuote(req: GetSwapQuoteRequest): Promise<GetSwapQuoteResponse> {
  const account = await getActiveAccount(req.accountId)
  const network = await getActiveNetwork()
  const [payTokens, receiveTokens] = await Promise.all([
    loadPayTokens(req.accountId),
    loadReceiveTokens(req.accountId),
  ])
  const assetIn = findSwapToken(payTokens, req.assetInId)
  const assetOut = findSwapToken(receiveTokens, req.assetOutId)
  if (!assetIn || !assetOut) {
    throw new BackendError('Unknown swap token', { code: 'validation_error' })
  }
  if (assetIn.id === assetOut.id) {
    throw new BackendError('Cannot swap the same token', { code: 'validation_error' })
  }

  const slippageBps = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  const amountInRaw = humanToRaw(req.amountIn, assetIn.decimals)
  if (amountInRaw === '0') {
    throw new BackendError('Amount must be greater than zero', { code: 'validation_error' })
  }

  const provider = getActiveSwapProvider(network, req.providerId)
  const cacheKey = quoteCacheKey({
    network,
    provider: provider.id,
    in: assetIn.contractId,
    out: assetOut.contractId,
    amount: amountInRaw,
    slippage: slippageBps,
  })

  const quote = await getOrCreateQuote(cacheKey, () =>
    provider.quote({
      network,
      assetIn: swapTokenToAsset(assetIn),
      assetOut: swapTokenToAsset(assetOut),
      amountInRaw,
      slippageBps,
      recipient: account.smartAccountAddress!,
    })
  )

  return {
    quote: quoteToPayload(quote, assetIn, assetOut, slippageBps),
  }
}

export async function runPrepareSwapTx(req: PrepareSwapTxRequest): Promise<PrepareSwapTxResponse> {
  const account = await getActiveAccount(req.accountId)
  const network = await getActiveNetwork()
  const { quote: payload } = req
  const signerType = accountModeToSignerType(account)

  const buildBody = aquariusBuildParams(payload, network)
  if (buildBody) {
    return await buildSwapTx({
      ...buildBody,
      network,
      smartAccountAddress: account.smartAccountAddress!,
      signerType,
      signerG: account.gAddress,
      keyDataHex: passkeyKeyDataHex(account),
    })
  }

  // Non-Aquarius providers: extension-built XDR + prepare-sign (with fee-payer hint).
  const provider = getActiveSwapProvider(network, payload.providerId)
  const swapQuote: SwapQuote = {
    providerId: payload.providerId,
    providerName: payload.providerName,
    amountInRaw: payload.amountInRaw,
    amountOutRaw: payload.amountOutRaw,
    amountOutMinRaw: payload.amountOutMinRaw,
    pathLabels: payload.pathLabels,
    pools: payload.pools,
    expiresAtMs: payload.expiresAtMs,
    buildPayload: payload.buildPayload as SwapQuote['buildPayload'],
  }

  const quoteRequest = {
    network,
    assetIn: swapTokenToAsset(payload.assetIn),
    assetOut: swapTokenToAsset(payload.assetOut),
    amountInRaw: payload.amountInRaw,
    slippageBps: payload.slippageBps,
    recipient: account.smartAccountAddress!,
  }

  // Local aggregator / Aquarius XDR builds need a bundler G as tx source (sequence + fees).
  // Never fall back to an empty source — mainnet must set PLASMO_PUBLIC_LATCH_FEE_PAYER_G_MAINNET.
  const transactionSourceG = resolveSwapTransactionSourceG({
    gAddress: account.gAddress,
    network,
  })

  const unsignedTxXdr = await provider.buildUnsignedTx(
    quoteRequest,
    swapQuote,
    account.smartAccountAddress!,
    transactionSourceG,
    sorobanRpcUrlFor(network),
    networkPassphraseFor(network)
  )

  const prepared = await prepareSign({
    network,
    smartAccountAddress: account.smartAccountAddress!,
    unsignedTxXdr,
    signerType,
    signerG: account.gAddress,
    keyDataHex: passkeyKeyDataHex(account),
    // Bundler public G used as tx source when building local Soroswap XDR.
    feePayerG: transactionSourceG,
  })

  return prepared
}

/** Returns true if the message type was handled. */
export async function tryHandleSwapMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
): Promise<boolean> {
  switch (message.type) {
    case 'GET_SWAP_TOKEN_CATALOG': {
      const req = message.payload as GetSwapTokenCatalogRequest
      const data = await runGetSwapTokenCatalog(req)
      sendResponse(ok(data))
      return true
    }

    case 'GET_SWAP_QUOTE': {
      const req = message.payload as GetSwapQuoteRequest
      const data = await withCancellableWaiter(req.requestId, () => runGetSwapQuote(req))
      sendResponse(ok(data))
      return true
    }

    case 'PREPARE_SWAP_TX': {
      const req = message.payload as PrepareSwapTxRequest
      const data = await runPrepareSwapTx(req)
      sendResponse(ok(data))
      return true
    }

    case 'SETUP_SWAP_RULES': {
      const req = message.payload as SetupSwapRulesRequest
      const network = req.network ?? (await getActiveNetwork())
      const data = await setupSwapRules({ ...req, network })
      sendResponse(ok(data))
      return true
    }

    default:
      return false
  }
}
