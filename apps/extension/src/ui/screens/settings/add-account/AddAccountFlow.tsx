import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  BackendWebauthnAuthenticationFinishResponse,
  BackendWebauthnBeginResponse,
  BackendWebauthnRegistrationFinishRequest,
  BackendWebauthnRegistrationFinishResponse,
  GetAccountsResponse,
  ImportMnemonicAccountRequest,
  ImportMnemonicAccountResponse,
  SetActiveAccountRequest,
  StoredAccount,
} from '@latch/types'

import { friendlyError, sendToBackground } from '../../../lib/backgroundClient'
import { useSeedPhraseWords } from '../../import-seed/useSeedPhraseWords'
import {
  assertBeginOptionsRpIdMatchesCanonicalDomain,
  assertRegistrationCeremonyForFinish,
  enrichWebauthnRpIdHashErrorMessage,
  prepareDiscoverableAuthenticationOptions,
  prepareRegistrationOptionsForCreate,
} from '../../../webauthn/passkey'
import { reservePasskeyName } from '../../../webauthn/passkeyName'
import { runWebauthnCredential } from '../../../webauthn/runWebauthnCredential'
import { AddAccountChooseMethodScreen, type AddAccountMethod } from './AddAccountChooseMethodScreen'
import { AddAccountCreatePasskeyScreen } from './AddAccountCreatePasskeyScreen'
import { AddAccountCreateScreen } from './AddAccountCreateScreen'
import { AddAccountPasskeyScreen } from './AddAccountPasskeyScreen'
import { AddAccountRecoveryPhraseScreen } from './AddAccountRecoveryPhraseScreen'
import { AddAccountSuccessScreen } from './AddAccountSuccessScreen'

type AddAccountStep =
  | 'chooseMethod'
  | 'passkey'
  | 'createPasskey'
  | 'recoveryPhrase'
  | 'createAccount'
  | 'success'

type PendingPasskey = { kind: 'authentication'; optionsJSON: unknown; assertion: unknown }

type PendingRecovery = {
  mnemonic: string
}

const CREATE_MIN_MS = 1200

export function AddAccountFlow({
  surface,
  onBack,
  onComplete,
  onAccountsChanged,
}: {
  surface: 'popup' | 'sidepanel'
  onBack: () => void
  onComplete: () => void
  onAccountsChanged: () => void
}) {
  const [step, setStep] = useState<AddAccountStep>('chooseMethod')
  const [selectedMethod, setSelectedMethod] = useState<AddAccountMethod | null>(null)
  const [accountName, setAccountName] = useState('Trading')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [passkeyPrefetchReady, setPasskeyPrefetchReady] = useState(false)
  const [passkeyPrefetchError, setPasskeyPrefetchError] = useState<string | null>(null)
  const [passkeyActionError, setPasskeyActionError] = useState<string | null>(null)
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [passkeyPrefetchNonce, setPasskeyPrefetchNonce] = useState(0)
  const passkeyPrefetchRef = useRef<
    | {
        kind: 'registration'
        optionsJSON: unknown
        displayName: string
        seq: number
        commitSeq: () => Promise<void>
      }
    | { kind: 'authentication'; optionsJSON: unknown }
    | null
  >(null)

  const pendingPasskeyRef = useRef<PendingPasskey | null>(null)
  const pendingRecoveryRef = useRef<PendingRecovery | null>(null)

  // The passkey prefetch needs the name the user typed on the previous step, but
  // must not re-run (and re-peek the passkey counter) on every keystroke.
  const accountNameRef = useRef(accountName)
  accountNameRef.current = accountName

  const seedWords = useSeedPhraseWords()

  useEffect(() => {
    if (step !== 'passkey' && step !== 'createPasskey') {
      setPasskeyPrefetchReady(false)
      setPasskeyPrefetchError(null)
      setPasskeyActionError(null)
      setPasskeyBusy(false)
      passkeyPrefetchRef.current = null
      return
    }

    let cancelled = false
    setPasskeyPrefetchReady(false)
    setPasskeyPrefetchError(null)
    setPasskeyActionError(null)
    passkeyPrefetchRef.current = null

    void (async () => {
      try {
        if (step === 'createPasskey') {
          const accountsRes = await sendToBackground<undefined, GetAccountsResponse>({
            type: 'GET_ACCOUNTS',
            payload: undefined,
          })
          if (cancelled) return
          if (!accountsRes.ok) throw new Error(friendlyError(accountsRes.error))

          const reserved = await reservePasskeyName({
            accountLabel: accountNameRef.current,
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
          passkeyPrefetchRef.current = {
            kind: 'registration',
            optionsJSON,
            displayName,
            seq: reserved.seq,
            commitSeq: reserved.commit,
          }
        } else {
          const begin = await sendToBackground<undefined, BackendWebauthnBeginResponse>({
            type: 'PASSKEY_AUTH_BEGIN',
            payload: undefined,
          })
          if (cancelled) return
          if (!begin.ok) throw new Error(friendlyError(begin.error))

          const optionsJSON = prepareDiscoverableAuthenticationOptions(begin.data?.options)
          assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
          passkeyPrefetchRef.current = { kind: 'authentication', optionsJSON }
        }
        if (!cancelled) setPasskeyPrefetchReady(true)
      } catch (e) {
        if (!cancelled) {
          setPasskeyPrefetchError(e instanceof Error ? e.message : String(e))
          passkeyPrefetchRef.current = null
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [step, passkeyPrefetchNonce])

  /**
   * Label the new account, make it active, and land on success. Shared by the
   * create-passkey path (which finalizes right after the ceremony, since the
   * name was collected before it) and the existing-passkey / recovery-phrase
   * paths (which finalize from the create screen and keep its minimum spinner).
   */
  const finalizeAccount = useCallback(
    async (account: StoredAccount | undefined, opts?: { minDurationFrom?: number }) => {
      const label = accountNameRef.current.trim()
      if (account?.id) {
        await sendToBackground<{ accountId: string; label?: string }, undefined>({
          type: 'RENAME_ACCOUNT',
          payload: { accountId: account.id, label },
        })
        await sendToBackground<SetActiveAccountRequest, undefined>({
          type: 'SET_ACTIVE_ACCOUNT',
          payload: { accountId: account.id },
        })
      }

      if (opts?.minDurationFrom !== undefined) {
        const elapsed = Date.now() - opts.minDurationFrom
        if (elapsed < CREATE_MIN_MS) {
          await new Promise((resolve) => setTimeout(resolve, CREATE_MIN_MS - elapsed))
        }
      }

      onAccountsChanged()
      setStep('success')
    },
    [onAccountsChanged]
  )

  const runPasskeyAuthentication = useCallback(
    async (optionsJSON: unknown) => {
      assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
      return await runWebauthnCredential(surface, 'authentication', optionsJSON)
    },
    [surface]
  )

  const runPasskeyRegistration = useCallback(
    async (optionsJSON: unknown) => {
      assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
      return await runWebauthnCredential(surface, 'registration', optionsJSON)
    },
    [surface]
  )

  const handleAuthenticatePasskey = useCallback(() => {
    setPasskeyActionError(null)
    setPasskeyBusy(true)
    void (async () => {
      try {
        const pre = passkeyPrefetchRef.current
        if (!pre || pre.kind !== 'authentication') {
          throw new Error(
            passkeyPrefetchError ??
              (passkeyPrefetchReady
                ? 'Passkey session is stale. Go back and try again.'
                : 'Still preparing passkey…')
          )
        }

        const optionsJSON = pre.optionsJSON
        const assertion = await runPasskeyAuthentication(optionsJSON)
        pendingPasskeyRef.current = { kind: 'authentication', optionsJSON, assertion }
        pendingRecoveryRef.current = null
        setStep('createAccount')
      } catch (e) {
        setPasskeyPrefetchNonce((n) => n + 1)
        setPasskeyActionError(e instanceof Error ? e.message : String(e))
      } finally {
        setPasskeyBusy(false)
      }
    })()
  }, [passkeyPrefetchError, passkeyPrefetchReady, runPasskeyAuthentication, surface])

  const handleCreatePasskey = useCallback(() => {
    setPasskeyActionError(null)
    setPasskeyBusy(true)
    void (async () => {
      try {
        const pre = passkeyPrefetchRef.current
        if (!pre || pre.kind !== 'registration') {
          throw new Error(
            passkeyPrefetchError ??
              (passkeyPrefetchReady
                ? 'Passkey session is stale. Go back and try again.'
                : 'Still preparing passkey…')
          )
        }

        const optionsJSON = pre.optionsJSON
        const registration = await runPasskeyRegistration(optionsJSON)
        assertRegistrationCeremonyForFinish(registration)

        const finish = await sendToBackground<
          BackendWebauthnRegistrationFinishRequest,
          BackendWebauthnRegistrationFinishResponse & { account: StoredAccount }
        >({
          type: 'PASSKEY_REG_FINISH',
          payload: { response: registration, displayName: pre.displayName, seq: pre.seq },
        })
        if (!finish.ok) {
          const errMsg = friendlyError(finish.error)
          throw new Error(
            await enrichWebauthnRpIdHashErrorMessage(errMsg, {
              optionsJSON,
              credentialResponse: registration,
            })
          )
        }

        // The authenticator now holds a passkey with this number; retire it only
        // now, so an abandoned or failed ceremony does not burn one.
        await pre.commitSeq()

        pendingPasskeyRef.current = null
        pendingRecoveryRef.current = null
        await finalizeAccount(finish.data!.account)
      } catch (e) {
        setPasskeyPrefetchNonce((n) => n + 1)
        setPasskeyActionError(e instanceof Error ? e.message : String(e))
      } finally {
        setPasskeyBusy(false)
      }
    })()
  }, [finalizeAccount, passkeyPrefetchError, passkeyPrefetchReady, runPasskeyRegistration, surface])

  const handleImportRecoveryPhrase = useCallback(() => {
    if (!seedWords.isValid) return
    pendingRecoveryRef.current = { mnemonic: seedWords.mnemonic }
    pendingPasskeyRef.current = null
    setStep('createAccount')
  }, [seedWords.isValid, seedWords.mnemonic])

  const finishCreateAccount = useCallback(async () => {
    const label = accountName.trim()
    if (!label) return

    // Creating a new passkey: the name is collected *before* the ceremony so it
    // can become the passkey's label in the credential manager, so this screen
    // only advances. handleCreatePasskey finalizes once the passkey exists.
    if (selectedMethod === 'createPasskey') {
      setCreateError(null)
      setStep('createPasskey')
      return
    }

    setCreateError(null)
    setCreating(true)
    const started = Date.now()

    try {
      let account: StoredAccount | undefined
      const pending = pendingPasskeyRef.current

      if (pending?.kind === 'authentication') {
        const { assertion, optionsJSON } = pending
        const res = await sendToBackground<
          { response: unknown },
          BackendWebauthnAuthenticationFinishResponse & { account: StoredAccount }
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
        account = res.data!.account
      } else if (pendingRecoveryRef.current) {
        const req: ImportMnemonicAccountRequest = {
          mnemonic: pendingRecoveryRef.current.mnemonic,
          remember: false,
        }
        const res = await sendToBackground<
          ImportMnemonicAccountRequest,
          ImportMnemonicAccountResponse
        >({
          type: 'IMPORT_MNEMONIC_ACCOUNT',
          payload: req,
        })
        if (!res.ok) throw new Error(friendlyError(res.error))
        account = res.data!.account
      } else {
        throw new Error('No signer data available. Go back and try again.')
      }

      await finalizeAccount(account, { minDurationFrom: started })
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }, [accountName, finalizeAccount, selectedMethod])

  const handleCreateBack = useCallback(() => {
    if (creating) return
    setCreateError(null)
    if (selectedMethod === 'recoveryPhrase') {
      setStep('recoveryPhrase')
      return
    }
    if (selectedMethod === 'createPasskey') {
      // Naming now comes before the ceremony, so back goes to method choice.
      setStep('chooseMethod')
      return
    }
    setStep('passkey')
  }, [creating, selectedMethod])

  const handleContinueFromChoose = useCallback(() => {
    if (selectedMethod === 'passkey') {
      setStep('passkey')
      return
    }
    if (selectedMethod === 'createPasskey') {
      // Name the account first so the passkey can carry that label.
      setStep('createAccount')
      return
    }
    if (selectedMethod === 'recoveryPhrase') {
      setStep('recoveryPhrase')
    }
  }, [selectedMethod])

  const handleBackFromChoose = useCallback(() => {
    onBack()
  }, [onBack])

  const handleBackFromPasskeyOrRecovery = useCallback(() => {
    setStep('chooseMethod')
    setSelectedMethod(null)
  }, [])

  /** Back from the ceremony returns to the name step, keeping the chosen method. */
  const handleBackFromCreatePasskey = useCallback(() => {
    if (passkeyBusy) return
    setPasskeyActionError(null)
    setStep('createAccount')
  }, [passkeyBusy])

  if (step === 'success') {
    return (
      <AddAccountSuccessScreen
        accountName={accountName.trim()}
        onBack={onComplete}
        onViewAccounts={onComplete}
      />
    )
  }

  if (step === 'createAccount') {
    return (
      <AddAccountCreateScreen
        accountName={accountName}
        onAccountNameChange={setAccountName}
        creating={creating}
        createError={createError}
        onBack={handleCreateBack}
        onCreate={() => void finishCreateAccount()}
      />
    )
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      {step === 'chooseMethod' ? (
        <AddAccountChooseMethodScreen
          selected={selectedMethod}
          onSelect={setSelectedMethod}
          onContinue={handleContinueFromChoose}
          onBack={handleBackFromChoose}
        />
      ) : null}

      {step === 'passkey' ? (
        <AddAccountPasskeyScreen
          prefetchReady={passkeyPrefetchReady}
          prefetchError={passkeyPrefetchError}
          actionError={passkeyActionError}
          busy={passkeyBusy}
          onAuthenticate={handleAuthenticatePasskey}
          onBack={handleBackFromPasskeyOrRecovery}
        />
      ) : null}

      {step === 'createPasskey' ? (
        <AddAccountCreatePasskeyScreen
          prefetchReady={passkeyPrefetchReady}
          prefetchError={passkeyPrefetchError}
          actionError={passkeyActionError}
          busy={passkeyBusy}
          onCreatePasskey={handleCreatePasskey}
          onBack={handleBackFromCreatePasskey}
        />
      ) : null}

      {step === 'recoveryPhrase' ? (
        <AddAccountRecoveryPhraseScreen
          words={seedWords.words}
          onWordChange={seedWords.setWordAt}
          onPasteWords={seedWords.fillFromPaste}
          isValidPhrase={seedWords.isValid}
          onImportWallet={handleImportRecoveryPhrase}
          onBack={handleBackFromPasskeyOrRecovery}
        />
      ) : null}
    </div>
  )
}
