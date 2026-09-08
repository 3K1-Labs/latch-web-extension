import React, { useEffect, useRef, useState } from 'react'

import type {
  BackendWebauthnAuthenticationFinishResponse,
  BackendWebauthnBeginResponse,
  BackendWebauthnRegistrationFinishResponse,
  ImportMnemonicAccountRequest,
  ImportMnemonicAccountResponse,
  StoredAccount,
  UnlockMnemonicVaultRequest,
} from '@latch/types'

import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

import { ImportSeedScreen } from '../screens/import-seed/ImportSeedScreen'
import { useSeedPhraseWords } from '../screens/import-seed/useSeedPhraseWords'
import { UnlockMnemonicScreen } from '../screens/UnlockMnemonicScreen'
import { AddAnotherAccountScreen } from '../screens/accounts/AddAnotherAccountScreen'
import { PasskeyLoginScreen } from '../screens/accounts/PasskeyLoginScreen'
import { ChooseSignerScreen } from '../screens/accounts/ChooseSignerScreen'
import { CreatePasskeyScreen } from '../screens/accounts/CreatePasskeyScreen'
import { PasskeyCreatedScreen } from '../screens/accounts/PasskeyCreatedScreen'
import { openOnboardingTab } from '../onboarding/openOnboardingTab'
import { friendlyError, sendToBackground } from '../lib/backgroundClient'
import {
  assertBeginOptionsRpIdMatchesCanonicalDomain,
  assertRegistrationCeremonyForFinish,
  enrichWebauthnRpIdHashErrorMessage,
  nextPasskeyAccountDisplayName,
  prepareDiscoverableAuthenticationOptions,
  prepareRegistrationOptionsForCreate,
} from '../webauthn/passkey'
import { runWebauthnCredential } from '../webauthn/runWebauthnCredential'
import { resolveMainRoute, type Route, type Surface } from '../routing/routes'

const ACCOUNT_ROUTES = new Set([
  'addAccount',
  'addAccountPasskey',
  'chooseSigner',
  'createPasskey',
  'passkeyCreated',
  'importSeed',
  'importSeedEncrypt',
  'unlockMnemonic',
])

export function AccountRouteViews({
  route,
  surface,
  accounts,
  activeAccount,
  showOnboardingTabPrompt,
  unlockReturnRoute,
  routeContentMarginClass,
  flowHeightClass,
  loading,
  error,
  onSetLoading,
  onSetError,
  onSetRoute,
  onSetUnlockReturnRoute,
  onRefreshAccounts,
  onPersistSetupHasAccount,
}: {
  route: Route | string
  surface: Surface
  accounts: StoredAccount[]
  activeAccount: StoredAccount | undefined
  showOnboardingTabPrompt: boolean
  unlockReturnRoute: 'home' | 'migration' | null
  routeContentMarginClass: string
  flowHeightClass: string
  loading: string | null
  error: string | null
  onSetLoading: (v: string | null) => void
  onSetError: (v: string | null) => void
  onSetRoute: (route: Route) => void
  onSetUnlockReturnRoute: (v: 'home' | 'migration' | null) => void
  onRefreshAccounts: () => Promise<
    { accounts: StoredAccount[]; needsMnemonicUnlock: boolean } | undefined
  >
  onPersistSetupHasAccount: (publicKey: string) => Promise<void>
}) {
  const [chooseSignerForExistingWallet, setChooseSignerForExistingWallet] = useState(false)
  const [importSeedStep, setImportSeedStep] = useState<'phrase' | 'encrypt'>('phrase')
  const [pendingMnemonic, setPendingMnemonic] = useState('')
  const seedWords = useSeedPhraseWords()
  const [seedExtensionPassphrase, setSeedExtensionPassphrase] = useState('')
  const [seedEncryptionPassword, setSeedEncryptionPassword] = useState('')
  const [seedEncryptionConfirm, setSeedEncryptionConfirm] = useState('')
  const [unlockVaultPassword, setUnlockVaultPassword] = useState('')

  /** Prefetch /begin options so Create / Continue does not await the network before credentials. */
  const passkeyPrefetchRef = useRef<
    | { kind: 'registration'; optionsJSON: unknown; displayName: string }
    | { kind: 'authentication'; optionsJSON: unknown }
    | null
  >(null)
  const [passkeyPrefetchReady, setPasskeyPrefetchReady] = useState(false)
  const [passkeyPrefetchError, setPasskeyPrefetchError] = useState<string | null>(null)
  const [passkeyPrefetchNonce, setPasskeyPrefetchNonce] = useState(0)

  async function webauthnCredential(
    mode: 'registration' | 'authentication',
    optionsJSON: unknown
  ): Promise<unknown> {
    return runWebauthnCredential(surface, mode, optionsJSON)
  }

  useEffect(() => {
    if (route !== 'createPasskey' && route !== 'addAccountPasskey') {
      passkeyPrefetchRef.current = null
      setPasskeyPrefetchReady(false)
      setPasskeyPrefetchError(null)
      return
    }

    let cancelled = false
    setPasskeyPrefetchReady(false)
    setPasskeyPrefetchError(null)
    passkeyPrefetchRef.current = null

    void (async () => {
      try {
        if (route === 'createPasskey') {
          const displayName = nextPasskeyAccountDisplayName(accounts)
          const begin = await sendToBackground<
            { displayName?: string },
            BackendWebauthnBeginResponse
          >({
            type: 'PASSKEY_REG_BEGIN',
            payload: { displayName },
          })
          if (cancelled) return
          if (!begin.ok) throw new Error(friendlyError(begin.error))
          const optionsJSON = prepareRegistrationOptionsForCreate(
            (begin.data as BackendWebauthnBeginResponse | undefined)?.options,
            displayName
          )
          assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
          passkeyPrefetchRef.current = { kind: 'registration', optionsJSON, displayName }
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
    // Intentionally omit `accounts` identity: a new array reference must not
    // cancel an in-flight ceremony or re-issue /begin while the user is creating.
    // accounts length/contents are handled via route screen.
  }, [route, passkeyPrefetchNonce])

  async function beginMnemonicImport() {
    onSetError(null)
    onSetLoading('Importing wallet…')
    try {
      const req: ImportMnemonicAccountRequest = {
        mnemonic: pendingMnemonic,
        bip39Passphrase: seedExtensionPassphrase || undefined,
        remember: true,
        encryptionPassword: seedEncryptionPassword,
      }
      const res = await sendToBackground<
        ImportMnemonicAccountRequest,
        ImportMnemonicAccountResponse
      >({
        type: 'IMPORT_MNEMONIC_ACCOUNT',
        payload: req,
      })
      if (!res.ok) throw new Error(friendlyError(res.error))
      await onPersistSetupHasAccount(res.data!.smartAccountAddress)
      await onRefreshAccounts()
      seedWords.reset()
      setPendingMnemonic('')
      setSeedExtensionPassphrase('')
      setSeedEncryptionPassword('')
      setSeedEncryptionConfirm('')
      setImportSeedStep('phrase')
      onSetRoute('home')
    } finally {
      onSetLoading(null)
    }
  }

  async function unlockMnemonicVault() {
    if (!activeAccount?.id) throw new Error('No active account')
    onSetError(null)
    onSetLoading('Unlocking…')
    try {
      const res = await sendToBackground<UnlockMnemonicVaultRequest, undefined>({
        type: 'UNLOCK_MNEMONIC_VAULT',
        payload: { accountId: activeAccount.id, encryptionPassword: unlockVaultPassword },
      })
      if (!res.ok) throw new Error(friendlyError(res.error))
      setUnlockVaultPassword('')
      await onRefreshAccounts()
      const dest = unlockReturnRoute ?? 'home'
      onSetUnlockReturnRoute(null)
      onSetRoute(resolveMainRoute({ needsMnemonicUnlock: false, preferred: dest }))
    } finally {
      onSetLoading(null)
    }
  }

  async function beginPasskeyRegistration() {
    onSetError(null)
    onSetLoading('Creating passkey…')
    try {
      const pre = passkeyPrefetchRef.current
      if (!pre || pre.kind !== 'registration') {
        throw new Error(
          passkeyPrefetchError ??
            (passkeyPrefetchReady
              ? 'Passkey session is stale. Use Go Back, then return to Create Passkey.'
              : 'Still preparing passkey…')
        )
      }
      const optionsJSON = pre.optionsJSON
      assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
      const reg = (await webauthnCredential('registration', optionsJSON)) as Awaited<
        ReturnType<typeof startRegistration>
      >
      assertRegistrationCeremonyForFinish(reg)
      const res = await sendToBackground<
        { response: unknown },
        BackendWebauthnRegistrationFinishResponse & { account: StoredAccount }
      >({
        type: 'PASSKEY_REG_FINISH',
        payload: { response: reg },
      })
      if (!res.ok) {
        const errMsg = friendlyError(res.error)
        throw new Error(
          await enrichWebauthnRpIdHashErrorMessage(errMsg, { optionsJSON, credentialResponse: reg })
        )
      }
      await onPersistSetupHasAccount(res.data!.smartAccountAddress)
      await onRefreshAccounts()
      onSetRoute('passkeyCreated')
    } catch (e) {
      setPasskeyPrefetchNonce((n) => n + 1)
      throw e
    } finally {
      onSetLoading(null)
    }
  }

  async function loginWithExistingPasskey() {
    onSetError(null)
    onSetLoading('Logging in with passkey…')
    try {
      const pre = passkeyPrefetchRef.current
      if (!pre || pre.kind !== 'authentication') {
        throw new Error(
          passkeyPrefetchError ??
            (passkeyPrefetchReady
              ? 'Passkey session is stale. Use Go Back, then try again.'
              : 'Still preparing passkey…')
        )
      }
      const optionsJSON = pre.optionsJSON
      assertBeginOptionsRpIdMatchesCanonicalDomain(optionsJSON)
      const assertion = (await webauthnCredential('authentication', optionsJSON)) as Awaited<
        ReturnType<typeof startAuthentication>
      >
      const finish = await sendToBackground<
        { response: unknown },
        BackendWebauthnAuthenticationFinishResponse
      >({
        type: 'PASSKEY_AUTH_FINISH',
        payload: { response: assertion },
      })
      if (!finish.ok) {
        const errMsg = friendlyError(finish.error)
        throw new Error(
          await enrichWebauthnRpIdHashErrorMessage(errMsg, {
            optionsJSON,
            credentialResponse: assertion,
          })
        )
      }

      await onPersistSetupHasAccount(finish.data!.smartAccountAddress)
      await onRefreshAccounts()
      setChooseSignerForExistingWallet(false)
      onSetRoute('home')
    } catch (e) {
      setPasskeyPrefetchNonce((n) => n + 1)
      throw e
    } finally {
      onSetLoading(null)
    }
  }

  // Keep mounted for passkey prefetch when on relevant routes; skip unrelated routes.
  if (!ACCOUNT_ROUTES.has(route as string)) return null

  return (
    <>
      {!loading && route === 'addAccount' ? (
        <AddAnotherAccountScreen
          routeContentMarginClass={routeContentMarginClass}
          flowHeightClass={flowHeightClass}
          onPasskey={() => {
            setChooseSignerForExistingWallet(false)
            onSetRoute('addAccountPasskey')
          }}
          onImportSeed={() => onSetRoute('importSeed')}
          onCancel={() => onSetRoute('home')}
        />
      ) : null}

      {route === 'addAccountPasskey' ? (
        <PasskeyLoginScreen
          routeContentMarginClass={routeContentMarginClass}
          flowHeightClass={flowHeightClass}
          passkeyPrefetchError={passkeyPrefetchError}
          passkeyPrefetchReady={passkeyPrefetchReady}
          loading={loading}
          onContinue={() =>
            void loginWithExistingPasskey().catch((e) =>
              onSetError(e instanceof Error ? e.message : String(e))
            )
          }
          onGoBack={() => {
            onSetLoading(null)
            onSetRoute(chooseSignerForExistingWallet ? 'chooseSigner' : 'addAccount')
          }}
        />
      ) : null}

      {!loading && route === 'chooseSigner' && !showOnboardingTabPrompt ? (
        <ChooseSignerScreen
          routeContentMarginClass={routeContentMarginClass}
          flowHeightClass={flowHeightClass}
          chooseSignerForExistingWallet={chooseSignerForExistingWallet}
          onContinuePasskey={() =>
            onSetRoute(chooseSignerForExistingWallet ? 'addAccountPasskey' : 'createPasskey')
          }
          onGoBack={() => {
            setChooseSignerForExistingWallet(false)
            if (accounts.length > 0) {
              onSetRoute('home')
            } else {
              void openOnboardingTab()
            }
          }}
        />
      ) : null}

      {route === 'createPasskey' && !showOnboardingTabPrompt ? (
        <CreatePasskeyScreen
          routeContentMarginClass={routeContentMarginClass}
          flowHeightClass={flowHeightClass}
          passkeyPrefetchError={passkeyPrefetchError}
          passkeyPrefetchReady={passkeyPrefetchReady}
          loading={loading}
          onCreate={() =>
            void beginPasskeyRegistration().catch((e) =>
              onSetError(e instanceof Error ? e.message : String(e))
            )
          }
          onGoBack={() => {
            onSetLoading(null)
            onSetRoute('chooseSigner')
          }}
        />
      ) : null}

      {!loading && route === 'passkeyCreated' ? (
        <PasskeyCreatedScreen
          routeContentMarginClass={routeContentMarginClass}
          flowHeightClass={flowHeightClass}
          onGoToDashboard={() => onSetRoute('home')}
        />
      ) : null}

      {!loading &&
      (route === 'importSeed' || route === 'importSeedEncrypt') &&
      !showOnboardingTabPrompt ? (
        <div
          className={[
            `${routeContentMarginClass} flex min-h-0 flex-1 flex-col animate-screenIn`,
            flowHeightClass,
          ].join(' ')}
        >
          <ImportSeedScreen
            surface={surface}
            step={route === 'importSeedEncrypt' ? 'encrypt' : importSeedStep}
            words={seedWords.words}
            onWordChange={seedWords.setWordAt}
            onPasteWords={seedWords.fillFromPaste}
            isValidPhrase={seedWords.isValid}
            onBack={() => {
              if (route === 'importSeedEncrypt') {
                onSetRoute('importSeed')
                setImportSeedStep('phrase')
              } else if (accounts.length > 0) {
                onSetRoute('home')
              } else {
                void openOnboardingTab()
              }
            }}
            onProceedToEncrypt={() => {
              setPendingMnemonic(seedWords.mnemonic)
              setImportSeedStep('encrypt')
              onSetRoute('importSeedEncrypt')
            }}
            encryptionPassword={seedEncryptionPassword}
            encryptionConfirm={seedEncryptionConfirm}
            onEncryptionPasswordChange={setSeedEncryptionPassword}
            onEncryptionConfirmChange={setSeedEncryptionConfirm}
            onImport={() =>
              void beginMnemonicImport().catch((e) =>
                onSetError(e instanceof Error ? e.message : String(e))
              )
            }
            onEncryptBack={() => {
              onSetRoute('importSeed')
              setImportSeedStep('phrase')
            }}
            importError={error}
            busy={loading != null}
          />
        </div>
      ) : null}

      {!loading && route === 'unlockMnemonic' ? (
        <div
          className={[
            routeContentMarginClass,
            'flex flex-col animate-screenIn',
            flowHeightClass,
          ].join(' ')}
        >
          <UnlockMnemonicScreen
            password={unlockVaultPassword}
            onPasswordChange={setUnlockVaultPassword}
            onUnlock={() =>
              void unlockMnemonicVault().catch((e) =>
                onSetError(e instanceof Error ? e.message : String(e))
              )
            }
            error={error}
            busy={loading != null}
          />
        </div>
      ) : null}
    </>
  )
}
