import type {
  BackgroundMessage,
  BuildDelegatedTxRequest,
  BuildSendTxRequest,
  BuildTxRequest,
  SetupSendRulesRequest,
  SignDelegatedGAuthEntryRequest,
  SubmitDelegatedTxRequest,
  SubmitWebauthnTxRequest,
} from '@latch/types'

import { BackendError } from '../api/client'
import {
  buildDelegatedTx,
  buildSendTx,
  buildTx,
  setupSendRules,
  submitTxDelegated,
  submitTxWebauthn,
} from '../backend'
import { signDelegatedGAddressEntry } from '../delegatedLocalSign'
import type { OkFn } from '../messageResponse'
import { getMnemonicKeypair } from '../mnemonicSession'
import { getActiveNetwork } from '../network/config'
import {
  maybeProbeDelegatedEnforcingSim,
  maybeProbeWebauthnEnforcingSim,
} from './enforcingSimProbe'

/** Returns true if the message type was handled. */
export async function tryHandleTxMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
): Promise<boolean> {
  switch (message.type) {
    case 'SIGN_DELEGATED_G_AUTH_ENTRY': {
      const req = message.payload as SignDelegatedGAuthEntryRequest
      const kp = getMnemonicKeypair(req.accountId)
      if (!kp) {
        throw new BackendError(
          'Seed signer is not loaded. Re-open the wallet and unlock with your encryption password if you enabled Remember.',
          { code: 'mnemonic_locked' }
        )
      }
      const signed = await signDelegatedGAddressEntry({
        gAddressEntryTemplateXdr: req.gAddressEntryTemplateXdr,
        signer: kp,
        networkPassphrase: req.networkPassphrase,
      })
      sendResponse(ok(signed))
      return true
    }

    case 'BUILD_TX': {
      const req = message.payload as BuildTxRequest
      const data = await buildTx(req)
      sendResponse(ok(data))
      return true
    }

    case 'BUILD_DELEGATED_TX': {
      const req = message.payload as BuildDelegatedTxRequest
      const data = await buildDelegatedTx(req)
      sendResponse(ok(data))
      return true
    }

    case 'SUBMIT_TX_DELEGATED': {
      const req = message.payload as SubmitDelegatedTxRequest
      maybeProbeDelegatedEnforcingSim(req)
      const data = await submitTxDelegated(req)
      sendResponse(ok(data))
      return true
    }

    case 'SUBMIT_TX_WEBAUTHN': {
      const req = message.payload as SubmitWebauthnTxRequest
      maybeProbeWebauthnEnforcingSim(req)
      const data = await submitTxWebauthn(req)
      sendResponse(ok(data))
      return true
    }

    case 'BUILD_SEND_TX': {
      const req = message.payload as BuildSendTxRequest
      const network = req.network ?? (await getActiveNetwork())
      const data = await buildSendTx({ ...req, network })
      sendResponse(ok(data))
      return true
    }

    case 'SETUP_SEND_RULES': {
      const req = message.payload as SetupSendRulesRequest
      const network = req.network ?? (await getActiveNetwork())
      const data = await setupSendRules({ ...req, network })
      sendResponse(ok(data))
      return true
    }

    default:
      return false
  }
}
