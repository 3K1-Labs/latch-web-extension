import { useCallback, useEffect, useRef, useState } from 'react'
import { startRegistration } from '@simplewebauthn/browser'

import type {
  BackendWebauthnBeginResponse,
  BackendWebauthnRegistrationFinishRequest,
  BackendWebauthnRegistrationFinishResponse,
  GetAccountsResponse,
  SetSetupStateRequest,
  StoredAccount,
} from '@latch/types'

import { friendlyError, sendToBackground } from '../lib/backgroundClient'
import {
  assertBeginOptionsRpIdMatchesCanonicalDomain,
  assertRegistrationCeremonyForFinish,
  enrichWebauthnRpIdHashErrorMessage,
  formatWebauthnBrowserError,
  prepareRegistrationOptionsForCreate,
} from '../webauthn/passkey'
import { reservePasskeyName } from '../webauthn/passkeyName'

type PrefetchState = {
  kind: 'registration'
  optionsJSON: unknown
  displayName: string
  seq: number
  commitSeq: () => Promise<void>
}

export function useOnboardingPasskeyRegistration(active: boolean) {
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
        const accountsRes = await sendToBackground<undefined, GetAccountsResponse>({
          type: 'GET_ACCOUNTS',
          payload: undefined,
        })
        if (cancelled) return
        if (!accountsRes.ok) throw new Error(friendlyError(accountsRes.error))

        // First wallet has no user-chosen label yet, so this is "Latch Wallet N".
        const reserved = await reservePasskeyName({
          fallbackAccounts: accountsRes.data?.accounts ?? [],
        })
        if (cancelled) return
        const displayName = reserved.displayName
        const begin = await sendToBackground<
          { displayName?: string },
          BackendWebauthnBeginResponse
        >({
          type: 'PASSKEY_REG_BEGIN',
          payload: { displayName },
        })
        if (cancelled) return
        if (!begin.ok) throw new Error(friendlyError(begin.error))

        const optionsJSON = prepareRegistrationOptionsForCreate(begin.data?.options, displayName)
        assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
        prefetchRef.current = {
          kind: 'registration',
          optionsJSON,
          displayName,
          seq: reserved.seq,
          commitSeq: reserved.commit,
        }
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

  const createPasskey = useCallback(async (): Promise<StoredAccount> => {
    setActionError(null)
    setBusy(true)
    try {
      const pre = prefetchRef.current
      if (!pre || pre.kind !== 'registration') {
        throw new Error(
          prefetchError ??
            (prefetchReady
              ? 'Passkey session is stale. Go back and try again.'
              : 'Still preparing passkey…')
        )
      }

      const optionsJSON = pre.optionsJSON
      assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)

      let reg: Awaited<ReturnType<typeof startRegistration>>
      try {
        reg = await startRegistration({
          optionsJSON,
        } as Parameters<typeof startRegistration>[0])
      } catch (e) {
        throw new Error(formatWebauthnBrowserError(e))
      }

      assertRegistrationCeremonyForFinish(reg)

      const res = await sendToBackground<
        BackendWebauthnRegistrationFinishRequest,
        BackendWebauthnRegistrationFinishResponse & { account: StoredAccount }
      >({
        type: 'PASSKEY_REG_FINISH',
        payload: { response: reg, displayName: pre.displayName, seq: pre.seq },
      })

      if (!res.ok) {
        const errMsg = friendlyError(res.error)
        throw new Error(
          await enrichWebauthnRpIdHashErrorMessage(errMsg, {
            optionsJSON,
            credentialResponse: reg,
          })
        )
      }

      // The passkey now exists in the authenticator under this number, so retire
      // it. Only after finish: an abandoned ceremony must not burn a number.
      await pre.commitSeq()

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
    createPasskey,
  }
}
