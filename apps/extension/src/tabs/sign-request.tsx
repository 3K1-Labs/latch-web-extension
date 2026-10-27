import '../style.css'

import { useEffect, useState } from 'react'

import type {
  ExternalSignResult,
  GetAccountsResponse,
  PrepareSignResponse,
  RunExternalSignFlowPreparedResponse,
  StoredAccount,
} from '@latch/types'

import { parseSignRequestFromSearchParams } from '../background/externalSign/parseSignRequest'
import { externalResultToCallback } from '../background/externalSign/callbackUrl'
import { ExternalSignReviewScreen } from '../ui/screens/dapp/ExternalSignReviewScreen'
import { friendlyError, sendToBackground } from '../ui/lib/backgroundClient'

type Phase = 'loading' | 'review' | 'redirecting' | 'error'

export default function SignRequestTab() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<RunExternalSignFlowPreparedResponse | null>(null)
  const [activeAccount, setActiveAccount] = useState<StoredAccount | null>(null)
  const [busy, setBusy] = useState(false)
  const [progressLabel, setProgressLabel] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const signRequest = parseSignRequestFromSearchParams(window.location.search)
        const accountsRes = await sendToBackground<undefined, GetAccountsResponse>({
          type: 'GET_ACCOUNTS',
          payload: undefined,
        })
        if (!accountsRes.ok || !accountsRes.data) {
          throw new Error(friendlyError(accountsRes.error))
        }
        const { accounts, activeAccountId } = accountsRes.data
        const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0]
        if (!active) throw new Error('No wallet account found')
        setActiveAccount(active)

        const prepRes = await sendToBackground<
          { source: 'sign-request-tab'; request: typeof signRequest },
          RunExternalSignFlowPreparedResponse | ExternalSignResult
        >({
          type: 'PREPARE_EXTERNAL_SIGN',
          payload: { source: 'sign-request-tab', request: signRequest },
        })
        if (!prepRes.ok || !prepRes.data) {
          throw new Error(friendlyError(prepRes.error))
        }
        const data = prepRes.data
        if ('status' in data) {
          redirectWithResult(signRequest.callback!, data as ExternalSignResult, signRequest.submit)
          return
        }
        setSession(data as RunExternalSignFlowPreparedResponse)
        setPhase('review')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    })()
  }, [])

  useEffect(() => {
    function dismissPendingOnClose() {
      const requestId = session?.requestId
      if (!requestId || phase !== 'review') return
      void chrome.runtime.sendMessage({
        type: 'RESOLVE_PENDING_DAPP_REQUEST',
        payload: { requestId, approved: false },
      })
    }
    window.addEventListener('pagehide', dismissPendingOnClose)
    return () => window.removeEventListener('pagehide', dismissPendingOnClose)
  }, [session?.requestId, phase])

  function redirectWithResult(callback: string, result: ExternalSignResult, submit?: boolean) {
    setPhase('redirecting')
    const url = externalResultToCallback(callback, result, submit)
    window.location.replace(url)
  }

  async function handleConfirm() {
    if (!session?.prepared || !activeAccount || !session.signRequest.callback) return
    if (session.localReview?.confirmBlocked) return
    setBusy(true)
    setError(null)
    try {
      const submit = session.signRequest.submit !== false
      setProgressLabel(submit ? 'Submitting…' : 'Preparing…')
      // The background signs the build it stored for this request and refuses unsafe ones.
      const res = await sendToBackground<
        {
          requestId: string
          accountId: string
          prepared: PrepareSignResponse
          submit: boolean
        },
        { signedTxXdr?: string; signedAuthEntry?: string; txHash?: string }
      >({
        type: 'EXECUTE_DAPP_EXTERNAL_SIGN',
        payload: {
          requestId: session.requestId,
          accountId: activeAccount.id,
          prepared: session.prepared,
          submit,
        },
      })
      if (!res.ok || !res.data) throw new Error(friendlyError(res.error) || 'Signing failed.')
      const { txHash, signedTxXdr, signedAuthEntry } = res.data
      redirectWithResult(
        session.signRequest.callback,
        {
          status: 'signed',
          ...(submit ? { txHash } : { signedTxXdr, signedAuthEntry }),
          requestId: session.signRequest.requestId,
          network: session.signRequest.network,
        },
        submit
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setBusy(false)
      setProgressLabel(null)
      try {
        // No-op when the background already failed the request; clears it when it never got that far.
        await sendToBackground({
          type: 'RESOLVE_PENDING_DAPP_REQUEST',
          payload: {
            requestId: session.requestId,
            approved: false,
            errorMessage: message,
            errorCode: 'sign_failed',
          },
        })
      } catch {
        // Best-effort clear; still surface the original failure.
      }
      if (session.signRequest.callback) {
        redirectWithResult(
          session.signRequest.callback,
          {
            status: 'error',
            code: 'sign_failed',
            message,
            requestId: session.signRequest.requestId,
            network: session.signRequest.network,
          },
          session.signRequest.submit
        )
        return
      }
      setError(message)
    }
  }

  async function handleReject() {
    if (!session?.signRequest.callback) return
    await sendToBackground({
      type: 'RESOLVE_PENDING_DAPP_REQUEST',
      payload: { requestId: session.requestId, approved: false },
    })
    redirectWithResult(session.signRequest.callback, {
      status: 'rejected',
      code: 'user_rejected',
      message: 'User rejected',
      requestId: session.signRequest.requestId,
      network: session.signRequest.network,
    })
  }

  return (
    <div className="min-h-screen bg-bg text-fg font-sans">
      <div className="mx-auto flex h-screen w-full max-w-[400px] flex-col p-4">
        {phase === 'loading' || phase === 'redirecting' ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">
            {phase === 'redirecting' ? 'Returning to app…' : 'Preparing transaction…'}
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <p className="text-sm text-red-300">{error ?? 'Something went wrong'}</p>
          </div>
        ) : null}

        {phase === 'review' && session?.prepared ? (
          <ExternalSignReviewScreen
            origin={session.origin}
            prepared={session.prepared}
            localReview={session.localReview}
            busy={busy}
            progressLabel={progressLabel}
            error={error}
            onConfirm={() => void handleConfirm()}
            onReject={() => void handleReject()}
          />
        ) : null}
      </div>
    </div>
  )
}
