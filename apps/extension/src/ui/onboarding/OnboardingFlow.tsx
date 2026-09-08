import { useState } from 'react'

import { OnboardingAnimatedCard } from './OnboardingAnimatedCard'
import { OnboardingConfirmPasswordCard } from './OnboardingConfirmPasswordCard'
import { OnboardingCreateAccountCard } from './OnboardingCreateAccountCard'
import { OnboardingCreatePasskeyCard } from './OnboardingCreatePasskeyCard'
import { OnboardingHaveWalletCard, type ImportMethod } from './OnboardingHaveWalletCard'
import { OnboardingImportFailedCard } from './OnboardingImportFailedCard'
import { OnboardingImportRecoveryPhraseCard } from './OnboardingImportRecoveryPhraseCard'
import { OnboardingImportSuccessCard } from './OnboardingImportSuccessCard'
import { OnboardingPasskeyAuthSuccessCard } from './OnboardingPasskeyAuthSuccessCard'
import { OnboardingPasskeySuccessCard } from './OnboardingPasskeySuccessCard'
import { OnboardingUseExistingPasskeyCard } from './OnboardingUseExistingPasskeyCard'
import { OnboardingSetPasswordCard } from './OnboardingSetPasswordCard'
import { OnboardingWelcomeCard } from './OnboardingWelcomeCard'
import { openWalletAfterOnboarding } from './openWalletAfterOnboarding'
import { useOnboardingPasskeyAuthentication } from './useOnboardingPasskeyAuthentication'
import { useOnboardingPasskeyRegistration } from './useOnboardingPasskeyRegistration'
import { useOnboardingSeedImport } from './useOnboardingSeedImport'

type OnboardingStep =
  | 'welcome'
  | 'createAccount'
  | 'createPasskey'
  | 'passkeySuccess'
  | 'haveWallet'
  | 'importRecoveryPhrase'
  | 'setPassword'
  | 'confirmPassword'
  | 'importSuccess'
  | 'importFailed'
  | 'useExistingPasskey'
  | 'passkeyAuthSuccess'

export function OnboardingFlow() {
  const [step, setStep] = useState<OnboardingStep>('welcome')
  const [importMethod, setImportMethod] = useState<ImportMethod | null>(null)
  const passkey = useOnboardingPasskeyRegistration(step === 'createPasskey')
  const passkeyAuth = useOnboardingPasskeyAuthentication(step === 'useExistingPasskey')
  const seedImport = useOnboardingSeedImport()

  const goWelcome = () => {
    setImportMethod(null)
    seedImport.reset()
    setStep('welcome')
  }

  return (
    <OnboardingAnimatedCard stepKey={step}>
      {step === 'welcome' ? (
        <OnboardingWelcomeCard
          onCreateWallet={() => setStep('createAccount')}
          onImportWallet={() => setStep('haveWallet')}
        />
      ) : null}

      {step === 'createAccount' ? (
        <OnboardingCreateAccountCard
          onClose={goWelcome}
          onCreateWithPasskey={() => setStep('createPasskey')}
        />
      ) : null}

      {step === 'createPasskey' ? (
        <OnboardingCreatePasskeyCard
          prefetchReady={passkey.prefetchReady}
          prefetchError={passkey.prefetchError}
          actionError={passkey.actionError}
          busy={passkey.busy}
          onClose={() => setStep('createAccount')}
          onGoBack={() => setStep('createAccount')}
          onCreatePasskey={() => {
            void passkey.createPasskey().then(() => {
              setStep('passkeySuccess')
            })
          }}
        />
      ) : null}

      {step === 'passkeySuccess' ? (
        <OnboardingPasskeySuccessCard
          onClose={() => {
            void openWalletAfterOnboarding()
          }}
          onGoToDashboard={() => {
            void openWalletAfterOnboarding()
          }}
        />
      ) : null}

      {step === 'haveWallet' ? (
        <OnboardingHaveWalletCard
          selected={importMethod}
          onSelect={setImportMethod}
          onBack={goWelcome}
          onClose={goWelcome}
          onContinue={() => {
            if (importMethod === 'seedPhrase') {
              setStep('importRecoveryPhrase')
            } else if (importMethod === 'existingPasskey') {
              setStep('useExistingPasskey')
            }
          }}
        />
      ) : null}

      {step === 'importRecoveryPhrase' ? (
        <OnboardingImportRecoveryPhraseCard
          words={seedImport.words}
          onWordChange={seedImport.setWordAt}
          onPasteWords={seedImport.fillFromPaste}
          isValidPhrase={seedImport.isValidPhrase}
          verifying={seedImport.verifying}
          onBack={() => setStep('haveWallet')}
          onClose={goWelcome}
          onImportWallet={() => {
            void seedImport.verifyPhrase().then((ok) => {
              if (ok) {
                setStep('setPassword')
              } else {
                setStep('importFailed')
              }
            })
          }}
        />
      ) : null}

      {step === 'setPassword' ? (
        <OnboardingSetPasswordCard
          password={seedImport.password}
          onPasswordChange={seedImport.setPassword}
          onBack={() => setStep('importRecoveryPhrase')}
          onClose={goWelcome}
          onContinue={() => {
            seedImport.setConfirmPassword('')
            setStep('confirmPassword')
          }}
        />
      ) : null}

      {step === 'confirmPassword' ? (
        <OnboardingConfirmPasswordCard
          password={seedImport.confirmPassword}
          onPasswordChange={seedImport.setConfirmPassword}
          onBack={() => setStep('setPassword')}
          onClose={goWelcome}
          busy={seedImport.importing}
          onContinue={() => {
            if (seedImport.confirmPassword !== seedImport.password) {
              setStep('importFailed')
              return
            }
            void seedImport.importWallet().then((ok) => {
              setStep(ok ? 'importSuccess' : 'importFailed')
            })
          }}
        />
      ) : null}

      {step === 'importSuccess' ? (
        <OnboardingImportSuccessCard
          onGoToDashboard={() => {
            void openWalletAfterOnboarding()
          }}
        />
      ) : null}

      {step === 'importFailed' ? (
        <OnboardingImportFailedCard
          onClose={goWelcome}
          onTryAgain={() => {
            seedImport.reset()
            setImportMethod('seedPhrase')
            setStep('importRecoveryPhrase')
          }}
        />
      ) : null}

      {step === 'useExistingPasskey' ? (
        <OnboardingUseExistingPasskeyCard
          prefetchReady={passkeyAuth.prefetchReady}
          prefetchError={passkeyAuth.prefetchError}
          actionError={passkeyAuth.actionError}
          busy={passkeyAuth.busy}
          onGoBack={() => setStep('haveWallet')}
          onAuthenticate={() => {
            void passkeyAuth.authenticate().then(() => {
              setStep('passkeyAuthSuccess')
            })
          }}
        />
      ) : null}

      {step === 'passkeyAuthSuccess' ? (
        <OnboardingPasskeyAuthSuccessCard
          onGoToDashboard={() => {
            void openWalletAfterOnboarding()
          }}
        />
      ) : null}
    </OnboardingAnimatedCard>
  )
}
