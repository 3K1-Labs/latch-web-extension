import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AccountSignerRecord,
  BackendWebauthnAuthenticationFinishResponse,
  BackendWebauthnBeginResponse,
  ExecuteAddBackupSignerRequest,
  ExecuteAddBackupSignerResponse,
  ExecuteRemoveAccountSignerRequest,
  ExecuteRemoveAccountSignerResponse,
  ListAccountSignersRequest,
  ListAccountSignersResponse,
  StoredAccount,
} from '@latch/types'

import { consumePendingWalletOutcomeIf, writePendingWalletOutcome } from '../../lib/walletOutcome'
import { sendToBackground } from '../lib/backgroundClient'
import { AccountSignersScreen } from '../screens/settings/signers/AccountSignersScreen'
import { ConfirmRemoveSignerModal } from '../screens/settings/signers/ConfirmRemoveSignerModal'
import {
  assertBeginOptionsRpIdMatchesCanonicalDomain,
  prepareDiscoverableAuthenticationOptions,
} from '../webauthn/passkey'
import { runWebauthnCredential } from '../webauthn/runWebauthnCredential'
import { AddBackupPasskeyFlow } from './AddBackupPasskeyFlow'
import { signerErrorMessage, signerErrorNeedsReverify } from './signerErrors'

export function AccountSignersRouteViews({
  route,
  surface,
  activeAccount,
  accounts,
  onSetRoute,
}: {
  route: string
  surface: 'popup' | 'sidepanel'
  activeAccount: StoredAccount | undefined
  accounts: StoredAccount[]
  onSetRoute: (route: string) => void
}) {
  const [signers, setSigners] = useState<AccountSignerRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsReverify, setNeedsReverify] = useState(false)
  const [removeCredentialId, setRemoveCredentialId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  /** The step to re-run after the user proves ownership again. */
  const retryAfterReverifyRef = useRef<(() => Promise<void>) | null>(null)

  const smartAccountAddress = activeAccount?.smartAccountAddress

  const loadSigners = useCallback(async () => {
    if (!smartAccountAddress) {
      setSigners([])
      return
    }
    setLoading(true)
    try {
      const res = await sendToBackground<ListAccountSignersRequest, ListAccountSignersResponse>({
        type: 'LIST_ACCOUNT_SIGNERS',
        payload: { smartAccountAddress },
      })
      if (!res.ok) {
        setError(signerErrorMessage(res.error, 'Could not load signers.'))
        setNeedsReverify(signerErrorNeedsReverify(res.error))
        return
      }
      setSigners(res.data?.signers ?? [])
    } finally {
      setLoading(false)
    }
  }, [smartAccountAddress])

  useEffect(() => {
    if (route !== 'accountSigners') return
    setError(null)
    setNeedsReverify(false)
    void loadSigners()
  }, [route, loadSigners])

  // The popup is destroyed while a passkey ceremony holds focus, so an add or
  // remove that was still running lands its result here instead.
  useEffect(() => {
    void (async () => {
      const outcome = await consumePendingWalletOutcomeIf('accountSigners')
      if (!outcome || outcome.status === 'in_progress') return
      setBusyLabel(null)
      if (outcome.status === 'failure') {
        setError(outcome.error ?? 'Could not update signers.')
      }
      await loadSigners()
    })()
  }, [loadSigners])

  /**
   * Prove this browser session still owns a signer on the account.
   *
   * `not_a_signer` means the anonymous `sid` cookie was lost or rotated, not
   * that the user lost access — re-running the normal passkey login restores
   * the session so the failed step can be retried.
   */
  const handleReverify = useCallback(() => {
    setBusyLabel('Verifying your passkey…')
    setError(null)
    void (async () => {
      try {
        const begin = await sendToBackground<undefined, BackendWebauthnBeginResponse>({
          type: 'PASSKEY_AUTH_BEGIN',
          payload: undefined,
        })
        if (!begin.ok) throw new Error(signerErrorMessage(begin.error, 'Could not start passkey.'))

        const optionsJSON = prepareDiscoverableAuthenticationOptions(begin.data?.options)
        assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
        const assertion = await runWebauthnCredential(surface, 'authentication', optionsJSON)

        const finish = await sendToBackground<
          { response: unknown },
          BackendWebauthnAuthenticationFinishResponse
        >({
          type: 'PASSKEY_AUTH_FINISH',
          payload: { response: assertion },
        })
        if (!finish.ok)
          throw new Error(signerErrorMessage(finish.error, 'Could not verify passkey.'))

        setNeedsReverify(false)
        const retry = retryAfterReverifyRef.current
        retryAfterReverifyRef.current = null
        if (retry) await retry()
        else await loadSigners()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyLabel(null)
      }
    })()
  }, [loadSigners, surface])

  /** Retry only the confirm step for a signer that is on-chain but unindexed. */
  const handleFinishSetup = useCallback(
    (credentialId: string) => {
      if (!smartAccountAddress) return
      const run = async () => {
        setBusyLabel('Finishing setup…')
        setError(null)
        try {
          const res = await sendToBackground<
            ExecuteAddBackupSignerRequest,
            ExecuteAddBackupSignerResponse
          >({
            type: 'EXECUTE_ADD_BACKUP_SIGNER',
            payload: {
              smartAccountAddress,
              credentialId,
              surface,
              resumeConfirmOnly: true,
            },
          })
          if (!res.ok) {
            setError(signerErrorMessage(res.error, 'Could not finish setting up this passkey.'))
            setNeedsReverify(signerErrorNeedsReverify(res.error))
            if (signerErrorNeedsReverify(res.error)) retryAfterReverifyRef.current = run
            return
          }
          await loadSigners()
        } finally {
          setBusyLabel(null)
        }
      }
      void run()
    },
    [loadSigners, smartAccountAddress, surface]
  )

  const handleConfirmRemove = useCallback(() => {
    const credentialId = removeCredentialId
    if (!credentialId || !smartAccountAddress) return

    const run = async () => {
      setBusyLabel('Removing passkey…')
      setRemoveError(null)
      setError(null)
      try {
        if (surface === 'popup') {
          await writePendingWalletOutcome({ kind: 'accountSigners', status: 'in_progress' })
        }
        const res = await sendToBackground<
          ExecuteRemoveAccountSignerRequest,
          ExecuteRemoveAccountSignerResponse
        >({
          type: 'EXECUTE_REMOVE_ACCOUNT_SIGNER',
          payload: { smartAccountAddress, credentialId, surface },
        })
        if (!res.ok) {
          setRemoveError(signerErrorMessage(res.error, 'Could not remove this passkey.'))
          setNeedsReverify(signerErrorNeedsReverify(res.error))
          if (signerErrorNeedsReverify(res.error)) retryAfterReverifyRef.current = run
          return
        }
        setRemoveCredentialId(null)
        await loadSigners()
      } finally {
        setBusyLabel(null)
      }
    }
    void run()
  }, [loadSigners, removeCredentialId, smartAccountAddress, surface])

  if (route === 'addBackupPasskey') {
    return (
      <AddBackupPasskeyFlow
        surface={surface}
        activeAccount={activeAccount}
        accounts={accounts}
        onBack={() => onSetRoute('accountSigners')}
        onDone={() => onSetRoute('accountSigners')}
        onSignersChanged={() => {
          void loadSigners()
        }}
      />
    )
  }

  const signerBeingRemoved = signers.find((s) => s.credentialId === removeCredentialId)

  return (
    <>
      <AccountSignersScreen
        signers={signers}
        loading={loading}
        busyLabel={busyLabel}
        error={error}
        onReverify={needsReverify ? handleReverify : undefined}
        onBack={() => onSetRoute('home')}
        onAddBackupPasskey={() => onSetRoute('addBackupPasskey')}
        onFinishSetup={handleFinishSetup}
        onRemoveSigner={(credentialId) => {
          setRemoveError(null)
          setRemoveCredentialId(credentialId)
        }}
      />
      <ConfirmRemoveSignerModal
        isOpen={Boolean(removeCredentialId)}
        signerName={signerBeingRemoved?.label ?? 'this passkey'}
        busy={Boolean(busyLabel)}
        error={removeError ?? undefined}
        onCancel={() => {
          if (busyLabel) return
          setRemoveError(null)
          setRemoveCredentialId(null)
        }}
        onConfirm={handleConfirmRemove}
      />
    </>
  )
}
