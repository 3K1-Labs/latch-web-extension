/**
 * Wallet-side decode of unsigned Soroban tx XDR for hybrid external-sign review.
 * Pure helpers — no Chrome, no prepare-sign. Signing still requires Latch API.
 */

import {
  Address,
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
import type { StellarNetwork } from './curatedAssets'

export interface ParsedTxForReview {
  operations: PreparedSignOperation[]
  /** Unique invoke-contract ids in first-seen order. */
  invokeContractIds: string[]
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

type ParsedInvoke = { operations: PreparedSignOperation[]; contractIds: string[] }

function tryForwardInvoke(
  args: xdr.ScVal[],
  assetByContract: Map<string, { code: string }>
): ParsedInvoke | null {
  if (args.length !== FORWARD_ARG_COUNT) return null
  const feeToken = tryAddressFromScVal(args[0]!)
  const maxFeeRaw = tryI128FromScVal(args[2]!)
  const target = tryAddressFromScVal(args[4]!)
  if (!feeToken || maxFeeRaw === null || !target?.startsWith('C')) return null
  if (args[5]!.switch() !== xdr.ScValType.scvSymbol()) return null
  const targetFn = args[5]!.sym().toString()
  if (args[6]!.switch() !== xdr.ScValType.scvVec()) return null
  const targetArgs = args[6]!.vec() ?? []

  const inner = classifyInvoke(target, targetFn, targetArgs, assetByContract)
  const symbol = assetByContract.get(feeToken)?.code
  const maxFee = formatSacRawToHuman(maxFeeRaw, STELLAR_SAC_DISPLAY_DECIMALS)
  const fee: PreparedSignOperation = {
    type: 'network_fee',
    summary: `Network fee up to ${symbol ? `${maxFee} ${symbol}` : maxFee}`,
    details: {
      feeToken,
      maxFeeAmount: maxFeeRaw.toString(),
      ...(symbol ? { symbol } : {}),
    },
  }
  return { operations: [inner, fee], contractIds: [target] }
}

function parseInvokeOp(
  op: Transaction['operations'][number],
  assetByContract: Map<string, { code: string }>
): ParsedInvoke {
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
  if (fnName === FORWARD_FN) {
    const forwarded = tryForwardInvoke(args, assetByContract)
    if (forwarded) return forwarded
  }
  return {
    operations: [classifyInvoke(contractId, fnName, args, assetByContract)],
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
export function parseTxForReview(txXdr: string, networkPassphrase: string): ParsedTxForReview {
  const trimmed = txXdr.trim()
  if (!trimmed) {
    throw new Error('Missing transaction XDR')
  }

  const envelope = TransactionBuilder.fromXDR(trimmed, networkPassphrase)
  const tx = unwrapTransaction(envelope)
  const assetByContract = buildSacAssetInfoMap({
    networkPassphrase,
    network: networkFromPassphrase(networkPassphrase),
  })

  const operations: PreparedSignOperation[] = []
  const invokeContractIds: string[] = []
  const seen = new Set<string>()

  for (const op of tx.operations) {
    const parsed = parseInvokeOp(op, assetByContract)
    operations.push(...parsed.operations)
    for (const contractId of parsed.contractIds) {
      if (seen.has(contractId)) continue
      seen.add(contractId)
      invokeContractIds.push(contractId)
    }
  }

  if (operations.length === 0) operations.push(CONTRACT_INTERACTION)

  return { operations, invokeContractIds }
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort()
}

function contractIdSetsEqual(a: string[], b: string[]): boolean {
  const sa = sortedUnique(a)
  const sb = sortedUnique(b)
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
}

/**
 * Build local review rows from the dApp XDR and hard-block Confirm on
 * network / account / invoke-contract disagreement with prepared.txXdr.
 */
export function assessExternalSignReview(
  params: AssessExternalSignReviewParams
): ExternalSignLocalReview {
  let operations: PreparedSignOperation[] = []
  let invokeContractIds: string[] = []
  let unsignedParseFailed = false

  try {
    const parsed = parseTxForReview(params.unsignedTxXdr, params.networkPassphrase)
    operations = parsed.operations
    invokeContractIds = parsed.invokeContractIds
  } catch {
    unsignedParseFailed = true
    operations = []
    invokeContractIds = []
  }

  if (
    params.signRequestNetwork !== params.preparedNetwork ||
    params.signRequestNetwork !== params.activeNetwork ||
    params.preparedNetwork !== params.activeNetwork
  ) {
    return {
      operations,
      invokeContractIds,
      confirmBlocked: true,
      confirmBlockedReason:
        'Network mismatch between the dApp request, prepare-sign response, and active wallet network.',
      code: 'network_mismatch',
    }
  }

  const accountsMatch =
    stellarAddressEquals(params.signRequestSmartAccount, params.preparedSmartAccount) &&
    stellarAddressEquals(params.signRequestSmartAccount, params.activeSmartAccount) &&
    stellarAddressEquals(params.preparedSmartAccount, params.activeSmartAccount)

  if (!accountsMatch) {
    return {
      operations,
      invokeContractIds,
      confirmBlocked: true,
      confirmBlockedReason:
        'Smart account mismatch between the dApp request, prepare-sign response, and active wallet.',
      code: 'account_mismatch',
    }
  }

  if (unsignedParseFailed) {
    return {
      operations,
      invokeContractIds,
      confirmBlocked: true,
      confirmBlockedReason: 'Could not decode the unsigned transaction for review.',
      code: 'unparsable_xdr',
    }
  }

  let preparedIds: string[]
  try {
    preparedIds = parseTxForReview(params.preparedTxXdr, params.networkPassphrase).invokeContractIds
  } catch {
    return {
      operations,
      invokeContractIds,
      confirmBlocked: true,
      confirmBlockedReason: 'Could not decode the prepared transaction for consistency checks.',
      code: 'unparsable_xdr',
    }
  }

  if (!contractIdSetsEqual(invokeContractIds, preparedIds)) {
    return {
      operations,
      invokeContractIds,
      confirmBlocked: true,
      confirmBlockedReason:
        'Invoke contract id(s) in the unsigned transaction do not match the prepared transaction.',
      code: 'contract_mismatch',
    }
  }

  return {
    operations,
    invokeContractIds,
    confirmBlocked: false,
    confirmBlockedReason: null,
  }
}
