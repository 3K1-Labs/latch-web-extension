/**
 * Wallet-side decode of unsigned Soroban tx XDR for hybrid external-sign review.
 * Pure helpers — no Chrome, no prepare-sign. Signing still requires Latch API.
 */

import {
  Address,
  Asset,
  FeeBumpTransaction,
  Networks,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import type { ExternalSignLocalReview, Network, PreparedSignOperation } from '@latch/types'

import { formatSacRawToHuman, STELLAR_SAC_DISPLAY_DECIMALS } from './sacBalance'
import { buildSacAssetInfoMap, stellarAddressEquals } from './smartAccountTransactions'
import {
  CURATED_PORTFOLIO_ASSETS,
  FEE_FORWARDER_CONTRACT_ID,
  type StellarNetwork,
} from './curatedAssets'

export interface ParsedTxForReview {
  operations: PreparedSignOperation[]
  /** Unique invoke-contract ids in first-seen order. */
  invokeContractIds: string[]
  /** `user` of every unwrapped FeeForwarder.forward() call: the account paying the fee. */
  forwardUsers: string[]
  warnings: string[]
}

export interface ParseTxForReviewOptions {
  /** Latch FeeForwarder for this network. Only calls to this contract are unwrapped. */
  feeForwarderId?: string
}

function truncateMiddle(addr: string, left = 6, right = 4): string {
  if (addr.length <= left + right + 3) return addr
  return `${addr.slice(0, left)}...${addr.slice(-right)}`
}

function networkFromPassphrase(networkPassphrase: string): StellarNetwork {
  return networkPassphrase === Networks.PUBLIC ? 'mainnet' : 'testnet'
}

function unwrapTransaction(envelope: Transaction | FeeBumpTransaction): Transaction {
  if (envelope instanceof FeeBumpTransaction) {
    return envelope.innerTransaction
  }
  return envelope
}

function tryAddressFromScVal(val: xdr.ScVal): string | null {
  try {
    return Address.fromScVal(val).toString()
  } catch {
    return null
  }
}

function tryI128FromScVal(val: xdr.ScVal): bigint | null {
  try {
    const native = scValToNative(val)
    if (typeof native === 'bigint') return native
    if (typeof native === 'number' && Number.isFinite(native)) return BigInt(native)
    if (typeof native === 'string' && /^-?\d+$/.test(native)) return BigInt(native)
    return null
  } catch {
    return null
  }
}

const CONTRACT_INTERACTION: PreparedSignOperation = {
  type: 'contract_interaction',
  summary: 'Contract interaction',
}

/**
 * FeeForwarder.forward(fee_token, fee_amount, max_fee_amount, expiration_ledger,
 * target_contract, target_fn, target_args, user, relayer). fee_amount is a
 * relayer-filled placeholder; the user authorizes max_fee_amount.
 */
const FORWARD_FN = 'forward'
const FORWARD_ARG_COUNT = 9

type ParsedInvoke = {
  operations: PreparedSignOperation[]
  contractIds: string[]
  forwardUser?: string
  warnings?: string[]
}

type ParseContext = {
  assetByContract: Map<string, { code: string }>
  feeForwarderId?: string
  /** Fee tokens latch-api may charge in: XLM and USDC SACs. */
  allowedFeeTokens: Set<string>
}

function allowedFeeTokensFor(networkPassphrase: string, network: StellarNetwork): Set<string> {
  const ids = new Set([Asset.native().contractId(networkPassphrase)])
  const usdc = CURATED_PORTFOLIO_ASSETS[network].find((a) => a.code === 'USDC')
  if (usdc?.issuer) ids.add(new Asset(usdc.code, usdc.issuer).contractId(networkPassphrase))
  return ids
}

function tryForwardInvoke(
  forwarderId: string,
  args: xdr.ScVal[],
  ctx: ParseContext
): ParsedInvoke | null {
  if (args.length !== FORWARD_ARG_COUNT) return null
  const feeToken = tryAddressFromScVal(args[0]!)
  const maxFeeRaw = tryI128FromScVal(args[2]!)
  const target = tryAddressFromScVal(args[4]!)
  const user = tryAddressFromScVal(args[7]!)
  if (!feeToken || maxFeeRaw === null || !target?.startsWith('C') || !user) return null
  if (args[5]!.switch() !== xdr.ScValType.scvSymbol()) return null
  const targetFn = args[5]!.sym().toString()
  if (args[6]!.switch() !== xdr.ScValType.scvVec()) return null
  const targetArgs = args[6]!.vec() ?? []

  const inner = classifyInvoke(target, targetFn, targetArgs, ctx.assetByContract)
  const symbol = ctx.assetByContract.get(feeToken)?.code
  const maxFee = formatSacRawToHuman(maxFeeRaw, STELLAR_SAC_DISPLAY_DECIMALS)
  const feeAmountPart = symbol ? `${maxFee} ${symbol}` : `${maxFee} of ${truncateMiddle(feeToken)}`
  const fee: PreparedSignOperation = {
    type: 'network_fee',
    summary: `Network fee up to ${feeAmountPart}`,
    details: {
      feeToken,
      maxFeeAmount: maxFeeRaw.toString(),
      user,
      ...(symbol ? { symbol } : {}),
    },
  }
  const unexpectedFeeToken = !ctx.allowedFeeTokens.has(feeToken)
  if (unexpectedFeeToken) {
    fee.details = { ...fee.details, feeTokenWarning: 'unexpected_fee_token' }
  }
  const warnings = unexpectedFeeToken
    ? [
        `The network fee is paid in ${symbol ?? truncateMiddle(feeToken)}, not XLM or USDC. Only continue if you trust this request.`,
      ]
    : []
  return {
    operations: [inner, fee],
    contractIds: [forwarderId, target],
    forwardUser: user,
    warnings,
  }
}

function parseInvokeOp(op: Transaction['operations'][number], ctx: ParseContext): ParsedInvoke {
  const opaque: ParsedInvoke = { operations: [CONTRACT_INTERACTION], contractIds: [] }
  if (op.type !== 'invokeHostFunction' || !('func' in op) || !op.func) return opaque

  const func = op.func as xdr.HostFunction
  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return opaque

  const ic = func.invokeContract()
  let contractId: string
  try {
    contractId = Address.fromScAddress(ic.contractAddress()).toString()
  } catch {
    return opaque
  }

  const fnName = ic.functionName().toString()
  const args = ic.args()
  if (
    fnName === FORWARD_FN &&
    ctx.feeForwarderId &&
    stellarAddressEquals(contractId, ctx.feeForwarderId)
  ) {
    const forwarded = tryForwardInvoke(contractId, args, ctx)
    if (forwarded) return forwarded
  }
  return {
    operations: [classifyInvoke(contractId, fnName, args, ctx.assetByContract)],
    contractIds: [contractId],
  }
}

function classifyInvoke(
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
  assetByContract: Map<string, { code: string }>
): PreparedSignOperation {
  const truncatedContract = truncateMiddle(contractId)

  if (fnName === 'transfer' && args.length >= 3) {
    const to = tryAddressFromScVal(args[1]!)
    const amountRaw = tryI128FromScVal(args[2]!)
    if (to && amountRaw !== null) {
      const symbol = assetByContract.get(contractId)?.code
      const amount = formatSacRawToHuman(amountRaw, STELLAR_SAC_DISPLAY_DECIMALS)
      const amountPart = symbol ? `${amount} ${symbol}` : amount
      const summary = `Transfer ${amountPart} to ${truncateMiddle(to)}`
      return {
        type: 'sac_transfer',
        summary,
        details: {
          contract: contractId,
          function: fnName,
          to,
          amount: amountRaw.toString(),
          ...(symbol ? { symbol } : {}),
        },
      }
    }
  }

  return {
    type: 'invoke_contract',
    summary: `Call ${truncatedContract}::${fnName}`,
    details: {
      contract: contractId,
      function: fnName,
    },
  }
}

/**
 * Decode an unsigned (or prepared) transaction XDR into review rows + invoke contract ids.
 * Throws if the XDR cannot be parsed for the given network passphrase.
 */
export function parseTxForReview(
  txXdr: string,
  networkPassphrase: string,
  opts: ParseTxForReviewOptions = {}
): ParsedTxForReview {
  const trimmed = txXdr.trim()
  if (!trimmed) {
    throw new Error('Missing transaction XDR')
  }

  const envelope = TransactionBuilder.fromXDR(trimmed, networkPassphrase)
  const tx = unwrapTransaction(envelope)
  const network = networkFromPassphrase(networkPassphrase)
  const configuredForwarder =
    'feeForwarderId' in opts
      ? opts.feeForwarderId?.trim() || undefined
      : FEE_FORWARDER_CONTRACT_ID[network]
  const ctx: ParseContext = {
    assetByContract: buildSacAssetInfoMap({ networkPassphrase, network }),
    feeForwarderId: configuredForwarder,
    allowedFeeTokens: allowedFeeTokensFor(networkPassphrase, network),
  }

  const operations: PreparedSignOperation[] = []
  const invokeContractIds: string[] = []
  const forwardUsers: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  for (const op of tx.operations) {
    const parsed = parseInvokeOp(op, ctx)
    operations.push(...parsed.operations)
    for (const contractId of parsed.contractIds) {
      if (seen.has(contractId)) continue
      seen.add(contractId)
      invokeContractIds.push(contractId)
    }
    if (parsed.forwardUser) forwardUsers.push(parsed.forwardUser)
    for (const w of parsed.warnings ?? []) if (!warnings.includes(w)) warnings.push(w)
  }

  if (operations.length === 0) operations.push(CONTRACT_INTERACTION)

  return { operations, invokeContractIds, forwardUsers, warnings }
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort()
}

/**
 * The verified Latch FeeForwarder is excluded so a dApp's plain call still matches the
 * `forward()`-wrapped prepared tx. Any other contract, including a lookalike `forward`, counts.
 */
function contractIdSetsEqual(a: string[], b: string[], feeForwarderId?: string): boolean {
  const keep = (id: string) => !feeForwarderId || !stellarAddressEquals(id, feeForwarderId)
  const sa = sortedUnique(a.filter(keep))
  const sb = sortedUnique(b.filter(keep))
  if (sa.length !== sb.length) return false
  return sa.every((id, i) => stellarAddressEquals(id, sb[i]!))
}

export type AssessExternalSignReviewParams = {
  unsignedTxXdr: string
  preparedTxXdr: string
  networkPassphrase: string
  signRequestNetwork: Network
  preparedNetwork: Network
  activeNetwork: Network
  signRequestSmartAccount: string
  preparedSmartAccount: string
  activeSmartAccount: string
  feeForwarderId?: string
}

/**
 * Build local review rows from the dApp XDR and hard-block Confirm on
 * network / account / invoke-contract disagreement with prepared.txXdr.
 */
export function assessExternalSignReview(
  params: AssessExternalSignReviewParams
): ExternalSignLocalReview {
  const parseOpts: ParseTxForReviewOptions = { feeForwarderId: params.feeForwarderId }
  let operations: PreparedSignOperation[] = []
  let invokeContractIds: string[] = []
  let forwardUsers: string[] = []
  let warnings: string[] = []
  let unsignedParseFailed = false

  try {
    const parsed = parseTxForReview(params.unsignedTxXdr, params.networkPassphrase, parseOpts)
    operations = parsed.operations
    invokeContractIds = parsed.invokeContractIds
    forwardUsers = parsed.forwardUsers
    warnings = parsed.warnings
  } catch {
    unsignedParseFailed = true
  }

  const blocked = (
    code: NonNullable<ExternalSignLocalReview['code']>,
    reason: string
  ): ExternalSignLocalReview => ({
    operations,
    invokeContractIds,
    confirmBlocked: true,
    confirmBlockedReason: reason,
    code,
    ...(warnings.length > 0 ? { warnings } : {}),
  })

  if (
    params.signRequestNetwork !== params.preparedNetwork ||
    params.signRequestNetwork !== params.activeNetwork ||
    params.preparedNetwork !== params.activeNetwork
  ) {
    return blocked(
      'network_mismatch',
      'Network mismatch between the dApp request, prepare-sign response, and active wallet network.'
    )
  }

  const accountsMatch =
    stellarAddressEquals(params.signRequestSmartAccount, params.preparedSmartAccount) &&
    stellarAddressEquals(params.signRequestSmartAccount, params.activeSmartAccount) &&
    stellarAddressEquals(params.preparedSmartAccount, params.activeSmartAccount)

  if (!accountsMatch) {
    return blocked(
      'account_mismatch',
      'Smart account mismatch between the dApp request, prepare-sign response, and active wallet.'
    )
  }

  if (unsignedParseFailed) {
    return blocked('unparsable_xdr', 'Could not decode the unsigned transaction for review.')
  }

  let prepared: ParsedTxForReview
  try {
    prepared = parseTxForReview(params.preparedTxXdr, params.networkPassphrase, parseOpts)
  } catch {
    return blocked(
      'unparsable_xdr',
      'Could not decode the prepared transaction for consistency checks.'
    )
  }

  // prepare-sign wraps a dApp's plain call in forward(); the fee it adds must still be shown.
  if (!operations.some((op) => op.type === 'network_fee')) {
    operations = [...operations, ...prepared.operations.filter((op) => op.type === 'network_fee')]
  }
  for (const w of prepared.warnings) if (!warnings.includes(w)) warnings = [...warnings, w]

  const payers = [...forwardUsers, ...prepared.forwardUsers]
  if (payers.some((user) => !stellarAddressEquals(user, params.activeSmartAccount))) {
    return blocked(
      'user_mismatch',
      'This transaction charges the network fee to a different wallet than the active one.'
    )
  }

  if (!contractIdSetsEqual(invokeContractIds, prepared.invokeContractIds, params.feeForwarderId)) {
    return blocked(
      'contract_mismatch',
      'Invoke contract id(s) in the unsigned transaction do not match the prepared transaction.'
    )
  }

  return {
    operations,
    invokeContractIds,
    confirmBlocked: false,
    confirmBlockedReason: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
