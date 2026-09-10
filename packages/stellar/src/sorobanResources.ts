/**
 * Compare recording-mode vs enforcing-mode Soroban resource footprints (issue #61).
 *
 * Verdict (testnet, single-signer WebAuthn Send via PLASMO_PUBLIC_DEBUG_ENFORCING_SIM):
 * recording underestimates — confirmed `underestimated=true` with extraRo=4 and a higher
 * resource fee (~+155874 stroops). Local signed smart-account assemble/submit must use
 * {@link assembleWithEnforcingSimulation}. Product Send/Swap stay safe via Latch API
 * `submitWithBundler` enforcing re-sim. Unsigned G→C migration keeps recording-only
 * {@link simulateAndAssembleSoroban} (no smart-account `__check_auth`).
 */

import { SorobanDataBuilder, Transaction, xdr, type rpc } from '@stellar/stellar-sdk'

export interface SorobanResourceSummary {
  readOnlyKeys: number
  readWriteKeys: number
  instructions: number
  diskReadBytes: number
  writeBytes: number
  /** Resource fee from SorobanTransactionData (stroops). */
  resourceFee: bigint
  /** Present when summarizing a successful simulateTransaction response. */
  minResourceFee?: bigint
}

export interface ResourceCompareResult {
  /**
   * True when enforcing mode reports more footprint keys or a higher resource /
   * min resource fee than recording mode — the gap mobile hit for multisig.
   */
  underestimated: boolean
  recording: SorobanResourceSummary
  enforcing: SorobanResourceSummary
  extraReadOnlyKeys: number
  extraReadWriteKeys: number
  resourceFeeDelta: bigint
}

function summaryFromSorobanData(
  data: xdr.SorobanTransactionData,
  minResourceFee?: bigint
): SorobanResourceSummary {
  const resources = data.resources()
  const footprint = resources.footprint()
  return {
    readOnlyKeys: footprint.readOnly().length,
    readWriteKeys: footprint.readWrite().length,
    instructions: resources.instructions(),
    diskReadBytes: resources.diskReadBytes(),
    writeBytes: resources.writeBytes(),
    resourceFee: BigInt(data.resourceFee().toString()),
    ...(minResourceFee !== undefined ? { minResourceFee } : {}),
  }
}

function coerceSorobanData(
  data: xdr.SorobanTransactionData | SorobanDataBuilder | string | null | undefined
): xdr.SorobanTransactionData | null {
  if (data == null) return null
  if (typeof data === 'string') {
    return xdr.SorobanTransactionData.fromXDR(data, 'base64')
  }
  if (data instanceof SorobanDataBuilder) {
    return data.build()
  }
  // Already xdr.SorobanTransactionData (duck: has resources()).
  if (typeof (data as xdr.SorobanTransactionData).resources === 'function') {
    return data as xdr.SorobanTransactionData
  }
  return null
}

/** Summarize resources from a successful simulation response. */
export function summarizeSimulationResources(
  sim: rpc.Api.SimulateTransactionSuccessResponse
): SorobanResourceSummary {
  const data = coerceSorobanData(sim.transactionData)
  if (!data) {
    throw new Error('Simulation response missing transactionData')
  }
  const min =
    typeof sim.minResourceFee === 'string' && sim.minResourceFee.trim() !== ''
      ? BigInt(sim.minResourceFee)
      : undefined
  return summaryFromSorobanData(data, min)
}

/** Summarize resources already assembled onto a Soroban transaction envelope. */
export function summarizeTransactionResources(tx: Transaction): SorobanResourceSummary | null {
  try {
    const env = tx.toEnvelope()
    if (env.switch() !== xdr.EnvelopeType.envelopeTypeTx()) return null
    const ext = env.v1().tx().ext()
    if (ext.switch() !== 1) return null
    return summaryFromSorobanData(ext.sorobanData())
  } catch {
    return null
  }
}

/**
 * Compare a recording-mode footprint to a post-signature enforcing simulation.
 * `underestimated` is true when enforcing needs more ledger keys or a higher fee.
 */
export function compareResourceSummaries(
  recording: SorobanResourceSummary,
  enforcing: SorobanResourceSummary
): ResourceCompareResult {
  const extraReadOnlyKeys = Math.max(0, enforcing.readOnlyKeys - recording.readOnlyKeys)
  const extraReadWriteKeys = Math.max(0, enforcing.readWriteKeys - recording.readWriteKeys)
  const feeRec = recording.minResourceFee ?? recording.resourceFee
  const feeEnf = enforcing.minResourceFee ?? enforcing.resourceFee
  const resourceFeeDelta = feeEnf - feeRec
  const underestimated = extraReadOnlyKeys > 0 || extraReadWriteKeys > 0 || resourceFeeDelta > 0n

  return {
    underestimated,
    recording,
    enforcing,
    extraReadOnlyKeys,
    extraReadWriteKeys,
    resourceFeeDelta,
  }
}

export function formatResourceCompareLog(result: ResourceCompareResult): string {
  const { recording: r, enforcing: e } = result
  return (
    `[latch][issue-61] underestimated=${result.underestimated} ` +
    `recording={ro=${r.readOnlyKeys},rw=${r.readWriteKeys},ins=${r.instructions},fee=${r.resourceFee}` +
    (r.minResourceFee !== undefined ? `,minFee=${r.minResourceFee}` : '') +
    `} enforcing={ro=${e.readOnlyKeys},rw=${e.readWriteKeys},ins=${e.instructions},fee=${e.resourceFee}` +
    (e.minResourceFee !== undefined ? `,minFee=${e.minResourceFee}` : '') +
    `} extraRo=${result.extraReadOnlyKeys} extraRw=${result.extraReadWriteKeys} feeDelta=${result.resourceFeeDelta}`
  )
}
