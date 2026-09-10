import { rpc, Transaction, xdr } from '@stellar/stellar-sdk'

import { extractInvokeHostAuth, replaceInvokeHostAuth, txHasSignedAddressAuth } from './sorobanAuth'

/** Soroban fee used before simulation; often replaced by assembled tx fee. */
export const DEFAULT_SOROBAN_BASE_FEE = '1500000'

export function createRpcServer(rpcUrl: string): rpc.Server {
  return new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http:') })
}

function simulationErrorMessage(sim: rpc.Api.SimulateTransactionErrorResponse): string {
  const err = sim.error
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message)
  }
  return JSON.stringify(err)
}

function assertSimulationSuccess(
  sim: rpc.Api.SimulateTransactionResponse
): asserts sim is rpc.Api.SimulateTransactionSuccessResponse {
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(simulationErrorMessage(sim) || 'Simulation failed')
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error('Unexpected simulation response')
  }
  if (sim.transactionData == null) {
    throw new Error('Token SAC does not exist on this network — cannot transfer this asset.')
  }
}

/**
 * Re-simulate a transaction that already carries signed auth entries (enforcing
 * mode — host runs `__check_auth` for real), then re-assemble footprint/fees and
 * re-assert the exact signed auth (assembleTransaction rewrites op.auth).
 *
 * Mobile pattern: recording sim → sign → enforcing sim → assemble → setOpAuth.
 */
export async function assembleWithEnforcingSimulation(
  server: rpc.Server,
  txWithSignedAuth: Transaction,
  networkPassphrase?: string
): Promise<Transaction> {
  const passphrase = networkPassphrase ?? txWithSignedAuth.networkPassphrase
  const signedAuth = extractInvokeHostAuth(txWithSignedAuth).map((e) =>
    xdr.SorobanAuthorizationEntry.fromXDR(e.toXDR())
  )

  const sim = await server.simulateTransaction(txWithSignedAuth)
  assertSimulationSuccess(sim)

  let prepared = rpc.assembleTransaction(txWithSignedAuth, sim).build()
  if (signedAuth.length > 0) {
    prepared = replaceInvokeHostAuth(prepared, signedAuth, passphrase)
  }
  return prepared
}

/**
 * Simulates an unsigned Soroban tx and returns the fully built transaction (still unsigned).
 * Caller signs the result, then {@link sendAndPollSoroban}.
 *
 * If the transaction already has signed address-credential auth, runs an
 * {@link assembleWithEnforcingSimulation} pass instead so `__check_auth` footprint
 * is not under-reported (issue #61).
 */
export async function simulateAndAssembleSoroban(
  server: rpc.Server,
  transaction: Transaction
): Promise<Transaction> {
  if (txHasSignedAddressAuth(transaction)) {
    return assembleWithEnforcingSimulation(server, transaction)
  }

  const sim = await server.simulateTransaction(transaction)
  assertSimulationSuccess(sim)
  return rpc.assembleTransaction(transaction, sim).build()
}

export async function sendAndPollSoroban(
  server: rpc.Server,
  signed: Transaction,
  options?: { pollIntervalMs?: number; maxAttempts?: number }
): Promise<{
  status: 'SUCCESS' | 'FAILED'
  hash: string
  latestLedger?: number
  error?: string
  confirmationTimedOut?: boolean
}> {
  const pollIntervalMs = options?.pollIntervalMs ?? 1000
  const maxAttempts = options?.maxAttempts ?? 90

  const send = await server.sendTransaction(signed)
  if (send.status === 'ERROR' || send.status === 'TRY_AGAIN_LATER') {
    const err =
      'errorResult' in send && send.errorResult != null ? String(send.errorResult) : send.status
    return {
      status: 'FAILED',
      hash: send.hash,
      error: err,
    }
  }
  const hash = send.hash
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    const got = await server.getTransaction(hash)
    if (got.status === 'SUCCESS') {
      return { status: 'SUCCESS', hash, latestLedger: got.latestLedger }
    }
    if (got.status === 'FAILED') {
      const rx = 'resultXdr' in got && got.resultXdr != null ? String(got.resultXdr) : 'FAILED'
      return {
        status: 'FAILED',
        hash,
        error: rx,
        latestLedger: got.latestLedger,
      }
    }
  }
  return {
    status: 'FAILED',
    hash,
    error: 'Transaction timed out while confirming on ledger.',
    confirmationTimedOut: true,
  }
}
