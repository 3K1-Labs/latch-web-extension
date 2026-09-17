import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AttachBackupPasskeyRequest,
  AttachBackupPasskeyResponse,
  BackendWebauthnBeginResponse,
  ExecuteAddBackupSignerRequest,
  ExecuteAddBackupSignerResponse,
  StoredAccount,
} from '@latch/types'

import { writePendingWalletOutcome } from '../../lib/walletOutcome'
import { sendToBackground } from '../lib/backgroundClient'
import { AddBackupPasskeyNameScreen } from '../screens/settings/signers/AddBackupPasskeyNameScreen'
import { AddBackupPasskeyScreen } from '../screens/settings/signers/AddBackupPasskeyScreen'
import { BackupPasskeySuccessScreen } from '../screens/settings/signers/BackupPasskeySuccessScreen'
import {
  assertBeginOptionsRpIdMatchesCanonicalDomain,
  assertRegistrationCeremonyForFinish,
  enrichWebauthnRpIdHashErrorMessage,
  prepareRegistrationOptionsForCreate,
} from '../webauthn/passkey'
import { reservePasskeyName } from '../webauthn/passkeyName'
import { runWebauthnCredential } from '../webauthn/runWebauthnCredential'
import { signerErrorMessage } from './signerErrors'

type AddBackupPasskeyStep = 'name' | 'ceremony' | 'success'

/**
 * Add a second passkey that signs for the active wallet.
 *
 * Three steps, in this order for a reason: the name is collected first so it
 * can become the credential's label in the password manager, the ceremony
 * creates and attaches the credential, and only then does the background job
 * authorize it on-chain. The attach is cheap to repeat; the on-chain add is not,
 * so it runs in the background and survives the popup being destroyed.
 */
export function AddBackupPasskeyFlow({
  surface,
  activeAccount,
  accounts,
  onBack,
  onDone,
  onSignersChanged,
}: {
  surface: 'popup' | 'sidepanel'
  activeAccount: StoredAccount | undefined
  accounts: StoredAccount[]
  onBack: () => void
  onDone: () => void
  onSignersChanged: () => void
}) {
  const [step, setStep] = useState<AddBackupPasskeyStep>('name')
  const [passkeyName, setPasskeyName] = useState('Backup')
  const [prefetchReady, setPrefetchReady] = useState(false)
  const [prefetchError, setPrefetchError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [prefetchNonce, setPrefetchNonce] = useState(0)

  const prefetchRef = useRef<{
    optionsJSON: unknown
    displayName: string
    seq: number
    commitSeq: () => Promise<void>
  } | null>(null)

  // The prefetch needs the typed name and the account list, but must not re-run
  // (and re-peek the passkey counter) on every keystroke or account refresh —
  // re-running mid-ceremony would drop the options the user is acting on.
  const passkeyNameRef = useRef(passkeyName)
  passkeyNameRef.current = passkeyName
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts

  useEffect(() => {
    if (step !== 'ceremony') {
      setPrefetchReady(false)
      setPrefetchError(null)
      prefetchRef.current = null
      return
    }

    let cancelled = false
    setPrefetchReady(false)
    setPrefetchError(null)
    setActionError(null)
    prefetchRef.current = null

    void (async () => {
      try {
        const reserved = await reservePasskeyName({
          accountLabel: passkeyNameRef.current,
          context: 'backup',
          fallbackAccounts: accountsRef.current,
        })
        if (cancelled) return

        const begin = await sendToBackground<
          { displayName?: string },
          BackendWebauthnBeginResponse
        >({
          type: 'PASSKEY_REG_BEGIN',
          payload: { displayName: reserved.displayName },
        })
        if (cancelled) return
        if (!begin.ok) throw new Error(signerErrorMessage(begin.error, 'Could not start passkey.'))

        const optionsJSON = prepareRegistrationOptionsForCreate(
          begin.data?.options,
          reserved.displayName
        )
        assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
        prefetchRef.current = {
          optionsJSON,
          displayName: reserved.displayName,
          seq: reserved.seq,
          commitSeq: reserved.commit,
        }
        setPrefetchReady(true)
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
  }, [step, prefetchNonce])

  const handleCreateBackupPasskey = useCallback(() => {
    if (!activeAccount) {
      setActionError('No active wallet.')
      return
    }
    setActionError(null)
    setBusy(true)
    setBusyLabel('Creating passkey…')

    void (async () => {
      try {
        const pre = prefetchRef.current
        if (!pre) {
          throw new Error(
            prefetchError ??
              (prefetchReady
                ? 'Passkey session is stale. Go back and try again.'
                : 'Still preparing passkey…')
          )
        }

        const registration = await runWebauthnCredential(surface, 'registration', pre.optionsJSON)
        assertRegistrationCeremonyForFinish(registration)

        setBusyLabel('Linking passkey…')
        const attach = await sendToBackground<
          AttachBackupPasskeyRequest,
          AttachBackupPasskeyResponse
        >({
          type: 'ATTACH_BACKUP_PASSKEY',
          payload: {
            smartAccountAddress: activeAccount.smartAccountAddress,
            response: registration,
            displayName: pre.displayName,
            seq: pre.seq,
          },
        })
        if (!attach.ok) {
          const message = signerErrorMessage(attach.error, 'Could not link this passkey.')
          throw new Error(
            await enrichWebauthnRpIdHashErrorMessage(message, {
              optionsJSON: pre.optionsJSON,
              credentialResponse: registration,
            })
          )
        }

        // The authenticator now holds a passkey with this number; retire it only
        // now, so an abandoned or failed ceremony does not burn one.
        await pre.commitSeq()
        onSignersChanged()

        const signer = attach.data!.signer
        setBusyLabel('Approving with your current passkey…')
        if (surface === 'popup') {
          await writePendingWalletOutcome({ kind: 'accountSigners', status: 'in_progress' })
        }

        const executed = await sendToBackground<
          ExecuteAddBackupSignerRequest,
          ExecuteAddBackupSignerResponse
        >({
          type: 'EXECUTE_ADD_BACKUP_SIGNER',
          payload: {
            smartAccountAddress: activeAccount.smartAccountAddress,
            credentialId: signer.credentialId,
            keyDataHex: signer.keyDataHex,
            label: pre.displayName,
            seq: pre.seq,
            surface,
          },
        })
        onSignersChanged()
        if (!executed.ok) {
          throw new Error(signerErrorMessage(executed.error, 'Could not add this passkey.'))
        }

        setStep('success')
      } catch (e) {
        setPrefetchNonce((n) => n + 1)
        setActionError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        setBusyLabel(null)
      }
    })()
  }, [activeAccount, onSignersChanged, prefetchError, prefetchReady, surface])

  if (step === 'success') {
    return (
      <BackupPasskeySuccessScreen
        passkeyName={passkeyName.trim()}
        onBack={onDone}
        onViewSigners={onDone}
      />
    )
  }

  if (step === 'ceremony') {
    return (
      <AddBackupPasskeyScreen
        prefetchReady={prefetchReady}
        prefetchError={prefetchError}
        actionError={actionError}
        busy={busy}
        busyLabel={busyLabel}
        onCreatePasskey={handleCreateBackupPasskey}
        onBack={() => {
          if (busy) return
          setActionError(null)
          setStep('name')
        }}
      />
    )
  }

  return (
    <AddBackupPasskeyNameScreen
      passkeyName={passkeyName}
      onPasskeyNameChange={setPasskeyName}
      onBack={onBack}
      onContinue={() => setStep('ceremony')}
    />
  )
}
