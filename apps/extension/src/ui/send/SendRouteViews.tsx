import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  BackgroundRequestPayloadByType,
  BackgroundResponseDataByType,
  BuildSendTxRequest,
  BuildSendTxResponse,
  GetMarketPricesRequest,
  GetMarketPricesResponse,
  NetworkFee,
  SmartAccountBalanceRow,
  StoredAccount,
} from '@latch/types'

import { SendFlow } from '../screens/send/SendFlow'
import { saveToAddressBook } from '../screens/send/useAddressBook'
import { createMultisigSendProposalWithSetup } from '../lib/multisigProposal'
import { REVIEW_OUT_OF_DATE_MESSAGE, fitMaxSendAmount, type MaxFeeProbe } from '../lib/networkFee'
import { estimateSendWithSetup } from '../lib/sendEstimate'
import type { ReviewedFee } from '../lib/reviewedBuild'
import { classifySendResponse, gateReviewed } from '../lib/sendSubmitOutcome'
import { buildSendRequestFromDraft, enrichSendFailureDetail } from '../lib/sendTx'
import { friendlyError, logLatchError, sendToBackground } from '../lib/backgroundClient'
import {
  clearPendingWalletOutcome,
  consumePendingWalletOutcomeIf,
  writePendingWalletOutcome,
} from '../../lib/walletOutcome'
import {
  INITIAL_SEND_DRAFT,
  type SendDraft,
  type SendFeeEstimate,
  type SendResult,
  type SendStep,
} from '../types/send'

import type { Route, Surface } from '../routing/routes'

export function SendRouteViews({
  route,
  surface,
  activeAccount,
  accounts,
  activeNetwork,
  networkLabel,
  portfolioRows,
  portfolioLoading,
  portfolioError,
  routeContentMarginClass,
  flowHeightClass,
  loading,
  onSetRoute,
  onLoadPortfolio,
  onLoadMultisigProposals,
  onSetMultisigDetailProposalId,
  registerOpenSend,
}: {
  route: Route | string
  surface: Surface
  activeAccount: StoredAccount | undefined
  accounts: StoredAccount[]
  activeNetwork: 'testnet' | 'mainnet'
  networkLabel: string
  portfolioRows: SmartAccountBalanceRow[]
  portfolioLoading: boolean
  portfolioError: string | null
  routeContentMarginClass: string
  flowHeightClass: string
  loading: string | null
  onSetRoute: (route: Route) => void
  onLoadPortfolio: () => void
  onLoadMultisigProposals: () => void
  onSetMultisigDetailProposalId: (id: string) => void
  registerOpenSend?: (open: () => void) => void
}) {
  const [sendStep, setSendStep] = useState<SendStep>('selectToken')
  const [sendDraft, setSendDraft] = useState<SendDraft>(INITIAL_SEND_DRAFT)
  const [sendResult, setSendResult] = useState<SendResult | null>(null)
  const [sendProgressLabel, setSendProgressLabel] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendTokenPriceUsd, setSendTokenPriceUsd] = useState<number | null>(null)
  /** The build the summary is showing; Confirm signs exactly this while it is still valid. */
  const [reviewed, setReviewed] = useState<ReviewedFee | null>(null)
  /** When the in-flight estimate was requested: the reviewed build's age counts from here. */
  const estimateStartedAtRef = useRef(0)
  /** True while a Confirm is signing. */
  const submitLockRef = useRef(false)
  const [feeEstimateNonce, setFeeEstimateNonce] = useState(0)

  function resetSendFlow() {
    setSendDraft(INITIAL_SEND_DRAFT)
    setSendStep('selectToken')
    setSendResult(null)
    setSendError(null)
    setSendProgressLabel(null)
    setSendTokenPriceUsd(null)
    setReviewed(null)
  }

  const openSendFlow = useCallback(() => {
    resetSendFlow()
    onSetRoute('send')
    void onLoadPortfolio()
  }, [onSetRoute, onLoadPortfolio])

  useLayoutEffect(() => {
    registerOpenSend?.(openSendFlow)
  }, [registerOpenSend, openSendFlow])

  const loadMarketPriceForToken = useCallback(async (code: string): Promise<number | null> => {
    const res = await sendToBackground<GetMarketPricesRequest, GetMarketPricesResponse>({
      type: 'GET_MARKET_PRICES',
      payload: { tokens: [code] },
    })
    if (!res.ok || !res.data) return null
    return res.data.pricesByCodeUpper[code.toUpperCase()]?.priceUsd ?? null
  }, [])

  useEffect(() => {
    if (route !== 'send') return
    const code = sendDraft.token?.code?.trim()
    if (!code) {
      setSendTokenPriceUsd(null)
      return
    }
    let cancelled = false
    void loadMarketPriceForToken(code).then((p) => {
      if (!cancelled) setSendTokenPriceUsd(p)
    })
    return () => {
      cancelled = true
    }
  }, [route, sendDraft.token?.code, loadMarketPriceForToken])

  /** One-time send-rule setup. Settles the pending outcome so a dead popup reopens on the summary. */
  const runSendRulesSetup = useCallback(async () => {
    if (!activeAccount) return { ok: false as const, message: 'No active account' }
    const outcomePayload = { draft: sendDraft, sendTokenPriceUsd }
    try {
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'send',
          status: 'in_progress',
          payload: outcomePayload,
        })
      }
      const res = await sendToBackground<
        BackgroundRequestPayloadByType['RUN_SEND_RULES_SETUP'],
        BackgroundResponseDataByType['RUN_SEND_RULES_SETUP']
      >({
        type: 'RUN_SEND_RULES_SETUP',
        payload: {
          accountId: activeAccount.id,
          draft: sendDraft,
          network: activeNetwork,
          surface,
          outcomePayload,
        },
      })
      if (res.ok && res.data) return { ok: true as const, result: res.data.result }
      return { ok: false as const, message: friendlyError(res.error) || 'Wallet setup failed.' }
    } catch (e) {
      logLatchError('send:setup-rules', e)
      return { ok: false as const, message: e instanceof Error ? e.message : String(e) }
    } finally {
      if (surface === 'popup') await clearPendingWalletOutcome().catch(() => undefined)
    }
  }, [activeAccount, sendDraft, sendTokenPriceUsd, activeNetwork, surface])

  const fetchSendFeeEstimate = useCallback(
    async (opts?: { onSettingUp?: () => void }): Promise<SendFeeEstimate> => {
      if (!activeAccount || activeAccount.mode === 'multisig') return null
      const buildBody = buildSendRequestFromDraft(
        sendDraft,
        activeAccount,
        sendTokenPriceUsd,
        activeNetwork
      )
      if (!buildBody) return null
      const build = async (): Promise<NonNullable<SendFeeEstimate>> => {
        estimateStartedAtRef.current = Date.now()
        try {
          const buildRes = await sendToBackground<BuildSendTxRequest, BuildSendTxResponse>({
            type: 'BUILD_SEND_TX',
            payload: buildBody,
          })
          if (buildRes.ok && buildRes.data) return { ok: true, data: buildRes.data }
          return { ok: false, error: buildRes.error ?? { message: 'Could not estimate the fee.' } }
        } catch (e) {
          logLatchError('send:fee-estimate', e)
          return { ok: false, error: { message: e instanceof Error ? e.message : String(e) } }
        }
      }
      return estimateSendWithSetup({
        build,
        runSetup: runSendRulesSetup,
        onSettingUp: opts?.onSettingUp,
      })
    },
    [activeAccount, sendDraft, sendTokenPriceUsd, activeNetwork, runSendRulesSetup]
  )

  const handleReviewedBuild = useCallback((build: BuildSendTxResponse | null) => {
    setReviewed(
      build ? { networkFee: build.networkFee ?? null, builtAt: estimateStartedAtRef.current } : null
    )
  }, [])

  /** Balance less the max fee of the real build at that amount; unchanged when probing fails. */
  const resolveMaxSendAmount = useCallback(
    async (token: SmartAccountBalanceRow): Promise<string | null> => {
      if (!activeAccount || activeAccount.mode === 'multisig') return token.amount
      const probeAt = async (amount: string): Promise<MaxFeeProbe> => {
        const probeBody = buildSendRequestFromDraft(
          { ...sendDraft, token, amount, inputMode: 'crypto' },
          activeAccount,
          sendTokenPriceUsd,
          activeNetwork
        )
        if (!probeBody) return { ok: false }
        const res = await sendToBackground<BuildSendTxRequest, BuildSendTxResponse>({
          type: 'BUILD_SEND_TX',
          payload: probeBody,
        })
        if (!res.ok || !res.data) return { ok: false, code: res.error?.code }
        return { ok: true, networkFee: res.data.networkFee }
      }
      try {
        return await fitMaxSendAmount(token, probeAt)
      } catch (e) {
        logLatchError('send:max-fee', e)
        return null
      }
    },
    [activeAccount, sendDraft, sendTokenPriceUsd, activeNetwork]
  )

  useEffect(() => {
    void (async () => {
      const outcome = await consumePendingWalletOutcomeIf('send')
      if (!outcome || outcome.status === 'in_progress') return
      const payload = outcome.payload ?? {}
      if (payload.draft) setSendDraft(payload.draft as SendDraft)
      if (typeof payload.sendTokenPriceUsd === 'number' || payload.sendTokenPriceUsd === null) {
        setSendTokenPriceUsd(payload.sendTokenPriceUsd as number | null)
      }
      setSendProgressLabel(null)
      if (outcome.status === 'review_again') {
        // Nothing was signed (fee changed or setup finished): back to the summary, which
        // re-runs its estimate and shows the fee that will be signed.
        setSendError(outcome.error ?? null)
        setSendStep('summary')
      } else if (outcome.status === 'success') {
        const result = (payload.result as SendResult | undefined) ?? {
          status: 'success' as const,
          submittedAt: new Date().toISOString(),
        }
        setSendResult(result)
        setSendStep('success')
        void onLoadPortfolio()
      } else {
        setSendResult({
          status: 'failure',
          errorMessage: outcome.error ?? 'Send failed.',
          submittedAt: new Date().toISOString(),
        })
        setSendStep('failure')
      }
      onSetRoute('send')
    })()
  }, [onLoadPortfolio, onSetRoute])

  async function handleSubmitSend() {
    // A double click must not start a second signing attempt before the first re-renders.
    if (submitLockRef.current) return
    submitLockRef.current = true
    setSendError(null)
    setSendProgressLabel('Building…')
    try {
      if (activeAccount?.mode === 'multisig') {
        const proposal = await createMultisigSendProposalWithSetup({
          draft: sendDraft,
          multisigAccount: activeAccount,
          accounts,
          priceUsd: sendTokenPriceUsd,
          surface,
          onProgress: setSendProgressLabel,
        })
        setSendResult({
          status: 'success',
          proposalId: proposal.id,
          submittedAt: new Date().toISOString(),
        })
        onSetMultisigDetailProposalId(proposal.id)
        setSendStep('success')
        void onLoadPortfolio()
        void onLoadMultisigProposals()
        return
      }

      if (!activeAccount) throw new Error('No active account')

      if (gateReviewed(reviewed) === 'expired') {
        setReviewed(null)
        setSendError(REVIEW_OUT_OF_DATE_MESSAGE)
        setFeeEstimateNonce((n) => n + 1)
        return
      }

      const outcomePayload = {
        draft: sendDraft,
        sendTokenPriceUsd,
      }
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'send',
          status: 'in_progress',
          payload: outcomePayload,
        })
      }

      const res = await sendToBackground<
        {
          accountId: string
          draft: SendDraft
          sendTokenPriceUsd: number | null
          network: 'testnet' | 'mainnet'
          shownNetworkFee: NetworkFee | null
          reviewed?: boolean
          surface: Surface
          outcomePayload?: Record<string, unknown>
        },
        SendResult & { status: 'success' }
      >({
        type: 'EXECUTE_SEND_SUBMIT',
        payload: {
          accountId: activeAccount.id,
          draft: sendDraft,
          sendTokenPriceUsd,
          network: activeNetwork,
          shownNetworkFee: reviewed?.networkFee ?? null,
          reviewed: reviewed != null,
          surface,
          outcomePayload,
        },
      })
      const outcome = classifySendResponse(res)
      if (outcome === 'review_again') {
        // Nothing was signed: stay on the summary and show the fee that would be signed now.
        await clearPendingWalletOutcome()
        setSendError(friendlyError(res.error))
        setFeeEstimateNonce((n) => n + 1)
        return
      }
      if (outcome === 'failed') throw new Error(friendlyError(res.error) || 'Send failed.')

      const result = res.data!
      setSendResult(result)
      setSendStep('success')
      await clearPendingWalletOutcome()
      if (result.status === 'success') {
        void saveToAddressBook({
          address: sendDraft.recipientAddress,
          name: sendDraft.recipientName,
        }).catch((e) => {
          logLatchError('send:address-book', e)
        })
      }
      void onLoadPortfolio()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error('[latch:send]', message, e)
      const errorMessage = await enrichSendFailureDetail({
        errorMessage: message,
        draft: sendDraft,
        network: activeNetwork,
      })
      setSendResult({
        status: 'failure',
        errorMessage,
        submittedAt: new Date().toISOString(),
      })
      setSendStep('failure')
      if (surface === 'popup') {
        await writePendingWalletOutcome({
          kind: 'send',
          status: 'failure',
          error: errorMessage,
          payload: { draft: sendDraft, sendTokenPriceUsd },
        }).catch((err) => {
          logLatchError('send:pending-outcome', err)
        })
      }
    } finally {
      submitLockRef.current = false
      setSendProgressLabel(null)
    }
  }

  if (loading || route !== 'send') return null

  return (
    <div
      className={[
        `${routeContentMarginClass} flex min-h-0 flex-1 flex-col animate-screenIn`,
        flowHeightClass,
      ].join(' ')}
    >
      <SendFlow
        surface={surface}
        step={sendStep}
        draft={sendDraft}
        result={sendResult}
        portfolioRows={portfolioRows}
        portfolioLoading={portfolioLoading}
        portfolioError={portfolioError}
        tokenPriceUsd={sendTokenPriceUsd}
        networkLabel={networkLabel}
        network={activeNetwork}
        sendProgressLabel={sendProgressLabel}
        sendError={sendError}
        createProposalMode={activeAccount?.mode === 'multisig'}
        onDraftChange={(patch) => setSendDraft((d) => ({ ...d, ...patch }))}
        onStepChange={setSendStep}
        onBackFromSend={() => {
          resetSendFlow()
          onSetRoute('home')
        }}
        feeEstimateKey={feeEstimateNonce}
        onFetchFeeEstimate={fetchSendFeeEstimate}
        onReviewedBuild={handleReviewedBuild}
        onResolveMaxAmount={resolveMaxSendAmount}
        onSubmitSend={() => void handleSubmitSend()}
        onContinueHome={() => {
          if (sendResult?.proposalId && activeAccount?.mode === 'multisig') {
            onSetMultisigDetailProposalId(sendResult.proposalId)
            resetSendFlow()
            onSetRoute('multisigProposalDetail')
            return
          }
          resetSendFlow()
          onSetRoute('home')
        }}
        onTryAgainFromFailure={() => {
          setSendError(sendResult?.errorMessage ?? null)
          setSendStep('summary')
        }}
      />
    </div>
  )
}
