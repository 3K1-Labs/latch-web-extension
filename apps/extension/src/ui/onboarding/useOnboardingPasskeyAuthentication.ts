import { useCallback, useEffect, useRef, useState } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'

import type {
  BackendWebauthnAuthenticationFinishResponse,
  BackendWebauthnBeginResponse,
  SetSetupStateRequest,
  StoredAccount,
} from '@latch/types'

import { friendlyError, sendToBackground } from '../lib/backgroundClient'
import {
  assertBeginOptionsRpIdMatchesCanonicalDomain,
  enrichWebauthnRpIdHashErrorMessage,
  formatWebauthnBrowserError,
  prepareDiscoverableAuthenticationOptions,
} from '../webauthn/passkey'

type PrefetchState = {
  kind: 'authentication'
  optionsJSON: unknown
}

export function useOnboardingPasskeyAuthentication(active: boolean) {
  const prefetchRef = useRef<PrefetchState | null>(null)
  const [prefetchReady, setPrefetchReady] = useState(false)
  const [prefetchError, setPrefetchError] = useState<string | null>(null)
  const [prefetchNonce, setPrefetchNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) {
      prefetchRef.current = null
      setPrefetchReady(false)
      setPrefetchError(null)
      setActionError(null)
      setBusy(false)
      return
    }

    let cancelled = false
    setPrefetchReady(false)
    setPrefetchError(null)
    prefetchRef.current = null

    void (async () => {
      try {
        const beginRes = await sendToBackground<undefined, BackendWebauthnBeginResponse>({
          type: 'PASSKEY_AUTH_BEGIN',
          payload: undefined,
        })
        if (cancelled) return

        if (!beginRes.ok) throw new Error(friendlyError(beginRes.error))

        const optionsJSON = prepareDiscoverableAuthenticationOptions(beginRes.data?.options)
        assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)

        prefetchRef.current = { kind: 'authentication', optionsJSON }

        if (!cancelled) setPrefetchReady(true)
      } catch (e) {
        if (!cancelled) {
          setPrefetchError(e instanceof Error ? e.message : String(e))
          prefetchRef.current = null
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active, prefetchNonce])

  const authenticate = useCallback(async (): Promise<StoredAccount> => {
    setActionError(null)
    setBusy(true)
    try {
      const pre = prefetchRef.current
      if (!pre || pre.kind !== 'authentication') {
        throw new Error(
          prefetchError ??
            (prefetchReady
              ? 'Passkey session is stale. Go back and try again.'
              : 'Still preparing passkey…')
        )
      }

      const optionsJSON = pre.optionsJSON
      assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)

      let assertion: Awaited<ReturnType<typeof startAuthentication>>
      try {
        assertion = await startAuthentication({
          optionsJSON,
        } as Parameters<typeof startAuthentication>[0])
      } catch (e) {
        throw new Error(formatWebauthnBrowserError(e))
      }

      const res = await sendToBackground<
        { response: unknown },
        BackendWebauthnAuthenticationFinishResponse & {
          account: StoredAccount
        }
      >({
        type: 'PASSKEY_AUTH_FINISH',
        payload: { response: assertion },
      })

      if (!res.ok) {
        const errMsg = friendlyError(res.error)
        throw new Error(
          await enrichWebauthnRpIdHashErrorMessage(errMsg, {
            optionsJSON,
            credentialResponse: assertion,
          })
        )
      }

      const account = res.data!.account
      const setupReq: SetSetupStateRequest = {
        setupState: 'has_account',
        accountPublicKey: res.data!.smartAccountAddress,
      }
      await sendToBackground<SetSetupStateRequest, unknown>({
        type: 'SET_SETUP_STATE',
        payload: setupReq,
      })

      return account
    } catch (e) {
      setPrefetchNonce((n) => n + 1)
      const msg = e instanceof Error ? e.message : String(e)
      setActionError(msg)
      throw e
    } finally {
      setBusy(false)
    }
  }, [prefetchError, prefetchReady])

  return {
    prefetchReady,
    prefetchError,
    actionError,
    busy,
    authenticate,
  }
}
