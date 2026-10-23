import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'

import type {
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
import { NETWORK_FEE_CHANGED_CODE, maxSendAmountFromProbe } from '../lib/networkFee'
import { enrichSendFailureDetail, buildSendRequestFromDraft } from '../lib/sendTx'
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

/** Smallest SAC unit: builds a send only to learn its fee, never to submit. */
const FEE_PROBE_AMOUNT = '0.0000001'
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
  /** Fee the summary displayed; the background refuses to sign a build it doesn't cover. */
  const [shownNetworkFee, setShownNetworkFee] = useState<NetworkFee | null>(null)
  const [feeEstimateNonce, setFeeEstimateNonce] = useState(0)

  function resetSendFlow() {
    setSendDraft(INITIAL_SEND_DRAFT)
    setSendStep('selectToken')
    setSendResult(null)
    setSendError(null)
    setSendProgressLabel(null)
    setSendTokenPriceUsd(null)
    setShownNetworkFee(null)
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

  const fetchSendFeeEstimate = useCallback(async (): Promise<SendFeeEstimate> => {
    if (!activeAccount || activeAccount.mode === 'multisig') return null
    const buildBody = buildSendRequestFromDraft(
      sendDraft,
      activeAccount,
      sendTokenPriceUsd,
      activeNetwork
    )
    if (!buildBody) return null
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
  }, [activeAccount, sendDraft, sendTokenPriceUsd, activeNetwork])

  const handleReviewedNetworkFee = useCallback((fee: NetworkFee | null) => {
    setShownNetworkFee(fee)
  }, [])

  /** Balance less the max fee when that token pays the fee; unchanged when the probe fails. */
  const resolveMaxSendAmount = useCallback(
    async (token: SmartAccountBalanceRow): Promise<string | null> => {
      if (!activeAccount || activeAccount.mode === 'multisig') return token.amount
      const probeBody = buildSendRequestFromDraft(
        { ...sendDraft, token, amount: FEE_PROBE_AMOUNT, inputMode: 'crypto' },
        activeAccount,
        sendTokenPriceUsd,
        activeNetwork
      )
      if (!probeBody) return null
      try {
        const res = await sendToBackground<BuildSendTxRequest, BuildSendTxResponse>({
          type: 'BUILD_SEND_TX',
          payload: probeBody,
        })
        if (!res.ok || !res.data) {
          return maxSendAmountFromProbe(token, { ok: false, code: res.error?.code })
        }
        return maxSendAmountFromProbe(token, { ok: true, networkFee: res.data.networkFee })
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
      if (outcome.status === 'success') {
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
          shownNetworkFee,
          surface,
          outcomePayload,
        },
      })
      if (!res.ok && res.error?.code === NETWORK_FEE_CHANGED_CODE) {
        // Nothing was signed: stay on the summary and show the fee that would be signed now.
        await clearPendingWalletOutcome()
        setSendError(friendlyError(res.error))
        setFeeEstimateNonce((n) => n + 1)
        return
      }
      if (!res.ok) throw new Error(friendlyError(res.error) || 'Send failed.')

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
        onReviewedNetworkFee={handleReviewedNetworkFee}
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
