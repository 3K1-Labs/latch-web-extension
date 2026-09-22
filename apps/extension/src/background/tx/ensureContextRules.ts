/**
 * One-time smart-account context-rule setup, shared by send confirm, swap
 * confirm, and dapp external sign. Each caller hits the same backend
 * `setup-*-rules` endpoints, signs the returned setup transaction, and
 * repeats while the API reports more assets left to configure.
 */

import type {
  SetupSendRulesRequest,
  SetupSwapRulesRequest,
  StoredAccount,
  SubmitTxResponse,
} from '@latch/types'

import { BackendError, setupSendRules, setupSwapRules } from '../backend'
import { getActiveNetwork } from '../network/config'
import { signAndSubmitBuiltTxInBackground } from './signBuiltTx'

/** setup-*-rules configures one asset per transaction; bound the loop. */
const MAX_SETUP_ATTEMPTS = 5

export type EnsureContextRulesResult = 'configured' | 'already_configured'

export function contextSetupErrShape(e: unknown): {
  code?: string
  status?: number
  message?: string
} {
  if (e instanceof BackendError) {
    return { code: e.code, status: e.status, message: e.message }
  }
  if (e instanceof Error) return { message: e.message }
  return { message: String(e) }
}

type SignAndSubmit = (args: {
  build: Parameters<typeof signAndSubmitBuiltTxInBackground>[0]['build']
  activeAccount: StoredAccount
}) => Promise<SubmitTxResponse>

export async function ensureSendRulesConfigured(args: {
  setupBody: SetupSendRulesRequest
  activeAccount: StoredAccount
  signAndSubmit?: SignAndSubmit
}): Promise<EnsureContextRulesResult> {
  const signAndSubmit = args.signAndSubmit ?? signAndSubmitBuiltTxInBackground
  for (let attempt = 0; attempt < MAX_SETUP_ATTEMPTS; attempt++) {
    const network = args.setupBody.network ?? (await getActiveNetwork())
    const setup = await setupSendRules({ ...args.setupBody, network })
    if (setup.alreadyConfigured) return 'already_configured'
    await signAndSubmit({ build: setup, activeAccount: args.activeAccount })
    if ((setup.remainingSetupCount ?? 0) <= 0) return 'configured'
  }
  throw new Error('Send setup did not complete')
}

export async function ensureSwapRulesConfigured(args: {
  setupBody: SetupSwapRulesRequest
  activeAccount: StoredAccount
  signAndSubmit?: SignAndSubmit
}): Promise<EnsureContextRulesResult> {
  const signAndSubmit = args.signAndSubmit ?? signAndSubmitBuiltTxInBackground
  for (let attempt = 0; attempt < MAX_SETUP_ATTEMPTS; attempt++) {
    let setup
    try {
      const network = args.setupBody.network ?? (await getActiveNetwork())
      setup = await setupSwapRules({ ...args.setupBody, network })
    } catch (e) {
      // The signer is already on the default rule — nothing left to set up.
      if (contextSetupErrShape(e).code === 'signer_already_exists') return 'already_configured'
      throw e instanceof Error ? e : new Error(String(e))
    }
    if (setup.alreadyConfigured) return 'already_configured'
    await signAndSubmit({ build: setup, activeAccount: args.activeAccount })
    if ((setup.remainingSetupCount ?? 0) <= 0) return 'configured'
  }
  throw new Error('Swap setup did not complete')
}

const inflightContextSetup = new Map<string, Promise<EnsureContextRulesResult>>()

export function contextSetupKey(parts: {
  network: string
  smartAccountAddress: string
  kind: 'send' | 'swap'
  target: string
}): string {
  return `${parts.network}|${parts.smartAccountAddress}|${parts.kind}|${parts.target}`
}

/**
 * Coalesce concurrent setup for the same account+rule so two dapp requests
 * cannot submit duplicate context-rule transactions.
 */
export function withInflightContextSetup(
  key: string,
  run: () => Promise<EnsureContextRulesResult>
): Promise<EnsureContextRulesResult> {
  const existing = inflightContextSetup.get(key)
  if (existing) return existing

  const promise = run().finally(() => {
    if (inflightContextSetup.get(key) === promise) {
      inflightContextSetup.delete(key)
    }
  })
  inflightContextSetup.set(key, promise)
  return promise
}

/** Test helper — drop any coalesced setup between cases. */
export function __resetContextSetupInflightForTests(): void {
  inflightContextSetup.clear()
}
