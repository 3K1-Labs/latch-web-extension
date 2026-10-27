import type {
  BackgroundMessage,
  BuildSendTxResponse,
  Network,
  NetworkFee,
  SwapQuotePayload,
} from '@latch/types'

import type { WalletOutcomeKind } from '../../lib/walletOutcome'
import type { OkFn } from '../messageResponse'
import type { SendDraft } from '../../ui/types/send'
import { recordKnownSacProbe } from '../knownSacProbes'
import { resolveAccountsForSign, signAndSubmitBuiltTxInBackground } from '../tx/signBuiltTx'
import { runPasskeyBridgeAndWait } from '../webauthn/passkeyBridge'
import { executeDappExternalSignInBackground } from './executeDappSign'
import { executeMultisigPasskeyApproveInBackground } from './executeMultisigApprove'
import { executeSendSubmitInBackground, setupSendRulesInBackground } from './executeSendSubmit'
import { executeSwapConfirmInBackground, setupSwapRulesInBackground } from './executeSwapConfirm'
import { finishOutcome } from './finishOutcome'
import { coalesce } from './inflight'
import { isReviewAgainError } from './reviewAgain'

/** Returns true if the message type was handled. */
export async function tryHandleConfirmMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
): Promise<boolean> {
  switch (message.type) {
    case 'RUN_PASSKEY_BRIDGE': {
      const req = message.payload as {
        mode: 'registration' | 'authentication'
        optionsJSON: unknown
        timeoutMs?: number
      }
      const data = await runPasskeyBridgeAndWait(req)
      sendResponse(ok(data))
      return true
    }

    case 'SIGN_PASSKEY_BUILT_TX': {
      const req = message.payload as {
        accountId: string
        signingAccountId?: string
        build: BuildSendTxResponse
        submit?: boolean
        surface?: 'popup' | 'sidepanel'
        outcomeKind?: WalletOutcomeKind
      }
      try {
        const { activeAccount, signingAccount } = await resolveAccountsForSign(req)
        const data = await signAndSubmitBuiltTxInBackground({
          build: req.build,
          activeAccount,
          signingAccount,
          submit: req.submit,
        })
        if (req.outcomeKind) {
          await finishOutcome({
            surface: req.surface,
            kind: req.outcomeKind,
            status: 'success',
          })
        }
        sendResponse(ok(data))
      } catch (e) {
        if (req.outcomeKind) {
          await finishOutcome({
            surface: req.surface,
            kind: req.outcomeKind,
            status: 'failure',
            error: e instanceof Error ? e.message : String(e),
          })
        }
        throw e
      }
      return true
    }

    case 'EXECUTE_SWAP_CONFIRM': {
      const req = message.payload as {
        accountId: string
        quote: SwapQuotePayload
        shownNetworkFee?: NetworkFee | null
        reviewed?: boolean
        surface: 'popup' | 'sidepanel'
        outcomePayload?: Record<string, unknown>
      }
      // One run per identical request: a double submit shares it (and settles the outcome once).
      const data = await coalesce(
        `swap:${req.accountId}:${req.quote.providerId}:${req.quote.amountInRaw}:${req.quote.expiresAtMs}`,
        async () => {
          try {
            const result = await executeSwapConfirmInBackground({
              accountId: req.accountId,
              quote: req.quote,
              shownNetworkFee: req.shownNetworkFee,
              reviewed: req.reviewed,
            })
            const assetOut = req.quote.assetOut
            if (assetOut?.contractId) {
              void recordKnownSacProbe(req.accountId, {
                code: assetOut.symbol,
                issuer: assetOut.issuer,
                sacContractId: assetOut.contractId,
              })
            }
            await finishOutcome({
              surface: req.surface,
              kind: 'swap',
              status: 'success',
              payload: req.outcomePayload,
            })
            return result
          } catch (e) {
            // Nothing was signed on a refusal: settle the record so a dead popup reopens on the
            // confirm screen with the message, not on home with a stranded `in_progress`.
            await finishOutcome({
              surface: req.surface,
              kind: 'swap',
              status: isReviewAgainError(e) ? 'review_again' : 'failure',
              error: e instanceof Error ? e.message : String(e),
              payload: req.outcomePayload,
            })
            throw e
          }
        }
      )
      sendResponse(ok(data))
      return true
    }

    case 'RUN_SWAP_RULES_SETUP': {
      const req = message.payload as {
        accountId: string
        quote: SwapQuotePayload
        surface: 'popup' | 'sidepanel'
        outcomePayload?: Record<string, unknown>
      }
      try {
        const result = await setupSwapRulesInBackground({
          accountId: req.accountId,
          quote: req.quote,
        })
        await finishOutcome({
          surface: req.surface,
          kind: 'swap',
          status: 'review_again',
          payload: req.outcomePayload,
        })
        sendResponse(ok({ result }))
      } catch (e) {
        await finishOutcome({
          surface: req.surface,
          kind: 'swap',
          status: 'review_again',
          error: e instanceof Error ? e.message : String(e),
          payload: req.outcomePayload,
        })
        throw e
      }
      return true
    }

    case 'RUN_SEND_RULES_SETUP': {
      const req = message.payload as {
        accountId: string
        draft: SendDraft
        network: Network
        surface: 'popup' | 'sidepanel'
        outcomePayload?: Record<string, unknown>
      }
      try {
        const result = await setupSendRulesInBackground({
          accountId: req.accountId,
          draft: req.draft,
          network: req.network,
        })
        await finishOutcome({
          surface: req.surface,
          kind: 'send',
          status: 'review_again',
          payload: req.outcomePayload,
        })
        sendResponse(ok({ result }))
      } catch (e) {
        await finishOutcome({
          surface: req.surface,
          kind: 'send',
          status: 'review_again',
          error: e instanceof Error ? e.message : String(e),
          payload: req.outcomePayload,
        })
        throw e
      }
      return true
    }

    case 'EXECUTE_SEND_SUBMIT': {
      const req = message.payload as {
        accountId: string
        draft: SendDraft
        sendTokenPriceUsd: number | null
        network: Network
        shownNetworkFee?: NetworkFee | null
        reviewed?: boolean
        surface: 'popup' | 'sidepanel'
        outcomePayload?: Record<string, unknown>
      }
      // One run per identical request: a double submit shares it (and settles the outcome once).
      const data = await coalesce(
        `send:${req.accountId}:${req.draft.recipientAddress}:${req.draft.amount}:${req.draft.token?.code}`,
        async () => {
          try {
            const result = await executeSendSubmitInBackground(req)
            await finishOutcome({
              surface: req.surface,
              kind: 'send',
              status: 'success',
              payload: { ...req.outcomePayload, result },
            })
            return result
          } catch (e) {
            await finishOutcome({
              surface: req.surface,
              kind: 'send',
              status: isReviewAgainError(e) ? 'review_again' : 'failure',
              error: e instanceof Error ? e.message : String(e),
              payload: req.outcomePayload,
            })
            throw e
          }
        }
      )
      sendResponse(ok(data))
      return true
    }

    case 'EXECUTE_DAPP_EXTERNAL_SIGN': {
      const req = message.payload as {
        requestId: string
        accountId: string
        prepared: BuildSendTxResponse
        submit: boolean
        surface?: 'popup' | 'sidepanel'
      }
      try {
        const data = await executeDappExternalSignInBackground(req)
        await finishOutcome({
          surface: req.surface,
          kind: 'dapp',
          status: 'success',
        })
        sendResponse(ok(data))
      } catch (e) {
        await finishOutcome({
          surface: req.surface,
          kind: 'dapp',
          status: 'failure',
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
      return true
    }

    case 'EXECUTE_MULTISIG_PASSKEY_APPROVE': {
      const req = message.payload as {
        accountId: string
        proposalId: string
        memberId: string
        authDigestHex: string
        memberCredentialId?: string
        surface: 'popup' | 'sidepanel'
        outcomePayload?: Record<string, unknown>
      }
      try {
        const data = await executeMultisigPasskeyApproveInBackground(req)
        await finishOutcome({
          surface: req.surface,
          kind: 'multisigApprove',
          status: 'success',
          payload: req.outcomePayload,
        })
        sendResponse(ok(data))
      } catch (e) {
        await finishOutcome({
          surface: req.surface,
          kind: 'multisigApprove',
          status: 'failure',
          error: e instanceof Error ? e.message : String(e),
          payload: req.outcomePayload,
        })
        throw e
      }
      return true
    }

    default:
      return false
  }
}
