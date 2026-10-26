import type {
  BuildSendTxRequest,
  BuildSendTxResponse,
  Network,
  NetworkFee,
  StoredAccount,
  SubmitTxResponse,
} from '@latch/types'

import { BackendError, buildSendTx } from '../backend'
import { getActiveNetwork } from '../network/config'
import { getAccounts } from '../storage'
import {
  contextSetupKey,
  ensureSendRulesConfigured,
  withInflightContextSetup,
} from '../tx/ensureContextRules'
import { signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'
import {
  buildSendRequestFromDraft,
  buildSetupRequestFromDraft,
  explainSendDraftNotBuildable,
  isBuildSendMissingSetupError,
  isNoContextRuleError,
  passkeySetupPrerequisiteError,
} from '../../ui/lib/sendTx'
import { networkFeeChanged, networkFeeEquals } from '../../ui/lib/networkFee'
import type { SendDraft } from '../../ui/types/send'
import { reviewAgainError } from './reviewAgain'
import { takeReviewedBuild } from './reviewedBuildStore'

function errShape(e: unknown): { code?: string; status?: number; message?: string } {
  if (e instanceof BackendError) {
    return { code: e.code, status: e.status, message: e.message }
  }
  if (e instanceof Error) return { message: e.message }
  return { message: String(e) }
}

function extractTransactionHash(data: SubmitTxResponse | null | undefined): string | undefined {
  if (!data) return undefined
  if (typeof data.transactionHash === 'string') return data.transactionHash
  if (typeof data.hash === 'string') return data.hash
  return undefined
}

export async function executeSendSubmitInBackground(args: {
  accountId: string
  draft: SendDraft
  sendTokenPriceUsd: number | null
  network: Network
  /** Fee shown on the summary. */
  shownNetworkFee?: NetworkFee | null
  /**
   * The user reviewed a build for exactly this draft. The background holds that build; it is
   * signed as-is while valid, and never rebuilt behind the user's back.
   */
  reviewed?: boolean
}): Promise<{ status: 'success'; hash?: string; submittedAt: string }> {
  const { accounts } = await getAccounts()
  const account = accounts.find((a) => a.id === args.accountId)
  if (!account) throw new Error('No active account')

  const buildBody = buildSendRequestFromDraft(
    args.draft,
    account,
    args.sendTokenPriceUsd,
    args.network
  )
  if (!buildBody) {
    throw new Error(
      explainSendDraftNotBuildable(args.draft, account, args.sendTokenPriceUsd) ??
        'Invalid send details'
    )
  }

  if (args.reviewed) {
    // Missing, expired, or priced differently from what the user saw: sign nothing, show it again.
    const reviewedBuild = await takeReviewedBuild<BuildSendTxResponse>('send', buildBody)
    if (!reviewedBuild) {
      console.warn('[latch:background] no held send build for this draft; asking to review again')
      throw reviewAgainError('out_of_date')
    }
    if (!networkFeeEquals(args.shownNetworkFee, reviewedBuild.networkFee)) {
      throw reviewAgainError('fee_changed')
    }
    try {
      const submitData = await signAndSubmitBuiltTxInBackground({
        build: reviewedBuild,
        activeAccount: account,
      })
      return {
        status: 'success',
        hash: extractTransactionHash(submitData),
        submittedAt: new Date().toISOString(),
      }
    } catch (e) {
      // Rules went missing since review: back to the summary, which sets them up and re-prices.
      if (isNoContextRuleError(errShape(e))) throw reviewAgainError('setup_needed')
      throw e
    }
  }

  let configuredSendRulesInLoop = false
  for (let attempt = 0; attempt < 5; attempt++) {
    let build: BuildSendTxResponse
    try {
      const network = buildBody.network ?? (await getActiveNetwork())
      build = await buildSendTx({ ...(buildBody as BuildSendTxRequest), network })
    } catch (e) {
      const shape = errShape(e)
      if (isBuildSendMissingSetupError(shape)) {
        const setupResult = await setupSendRulesForAccount(account, args.draft, args.network)
        if (setupResult === 'configured') configuredSendRulesInLoop = true
        if (
          setupResult === 'already_configured' &&
          !configuredSendRulesInLoop &&
          !isNoContextRuleError(shape)
        ) {
          throw e instanceof Error ? e : new Error(String(e))
        }
        continue
      }
      throw e instanceof Error ? e : new Error(String(e))
    }

    // Backstop for a rebuild with no reviewed build: never sign a fee the user didn't see.
    if (networkFeeChanged(args.shownNetworkFee, build.networkFee)) {
      throw reviewAgainError('fee_changed')
    }

    const submitData = await signAndSubmitBuiltTxInBackground({
      build,
      activeAccount: account,
    })
    return {
      status: 'success',
      hash: extractTransactionHash(submitData),
      submittedAt: new Date().toISOString(),
    }
  }

  throw new Error('Send setup did not complete')
}

/** One-time send-rule setup for this draft's token/recipient. */
export function setupSendRulesForAccount(
  account: StoredAccount,
  draft: SendDraft,
  network: Network
): Promise<'configured' | 'already_configured'> {
  const setupBody = buildSetupRequestFromDraft(draft, account, undefined, network)
  if (!setupBody) {
    throw new Error(
      passkeySetupPrerequisiteError(account) ??
        'Cannot set up send rules for this account. Sign in with your passkey again.'
    )
  }
  // Coalesced: a re-fired estimate must not open a second passkey ceremony for the same rules.
  const key = contextSetupKey({
    network: setupBody.network ?? network,
    smartAccountAddress: setupBody.smartAccountAddress,
    kind: 'send',
    target:
      [setupBody.assetId, ...(setupBody.assetIds ?? [])].filter(Boolean).join(',') || 'default',
  })
  return withInflightContextSetup(key, () =>
    ensureSendRulesConfigured({ setupBody, activeAccount: account })
  )
}

/** Same, by account id: run before Confirm enables. */
export async function setupSendRulesInBackground(args: {
  accountId: string
  draft: SendDraft
  network: Network
}): Promise<'configured' | 'already_configured'> {
  const { accounts } = await getAccounts()
  const account = accounts.find((a) => a.id === args.accountId)
  if (!account) throw new Error('No active account')
  return setupSendRulesForAccount(account, args.draft, args.network)
}
