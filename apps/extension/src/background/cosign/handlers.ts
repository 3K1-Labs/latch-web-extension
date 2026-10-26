import type { BackgroundMessage } from '@latch/types'

import {
  addCosignSignature,
  cancelCosignRequest,
  createCosignRequest,
  deleteJoinRelay,
  getCosignRequest,
  getJoinRelay,
  listPendingCosignRequests,
  postJoinRelay,
} from '../api/cosign/cosignQueue'
import {
  completeWalletSignInFromAssertion,
  requestWalletChallenge,
  resolveAccessToken,
} from '../api/v1Client'
import { assembleAndSubmitCosignRequest } from './assembleAndSubmit'
import { deployCosignMultisigWallet } from './deploy'
import { ensureDeviceTransportKeyPair } from './keyStorage'
import {
  announceMemberForWallet,
  discoverMembershipsForAccount,
  getCosignRecordForWallet,
} from './membership'
import { runCosignPollCycle } from './polling'
import { exportRawPublicKey, deriveBlindSignerId, deriveMemberBlindId, toBase64 } from './crypto'
import { signerPublicKeyBytesForAccount } from './signerBytes'
import { wckBytesFromRecord } from './wckStorage'
import { createAccount, getAccounts } from '../storage'
import { predictMultisigAccountFromSigners } from '../api/multisigAccounts'
import { prepareSign, submitTxWebauthn } from '../api/transactions'
import { latchFetch } from '../api/client'
import { latchExtensionJsonBody } from '../api/webauthn'
import { withActiveNetwork } from '../api/withActiveNetwork'
import { getActiveNetwork } from '../network/config'
import { deriveQueueIndex } from './crypto'
import { v1AuthWalletForLinkedAccount } from './v1AuthWallet'

type OkFn = (data?: unknown) => { ok: boolean; data?: unknown }

export async function tryHandleCosignMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
  ok: OkFn
): Promise<boolean> {
  switch (message.type) {
    case 'COSIGN_GET_TRANSPORT_PUBKEY': {
      const transport = await ensureDeviceTransportKeyPair()
      const pubkeyB64 = toBase64(await exportRawPublicKey(transport.publicKey))
      sendResponse(ok({ pubkeyB64 }))
      return true
    }
    case 'COSIGN_DEPLOY_ACCOUNT': {
      const req = message.payload as import('@latch/types').CosignDeployAccountRequest
      const { accounts } = await getAccounts()
      const creator = accounts.find((a) => a.id === req.creatorLinkedAccountId)
      if (!creator) throw new Error('Creator linked account not found')
      const data = await deployCosignMultisigWallet({
        threshold: req.threshold,
        signers: req.signers,
        accountSaltHex: req.accountSaltHex,
        walletName: req.walletName,
        inviteToken: req.inviteToken,
        creatorLinkedAccount: creator,
      })
      sendResponse(ok(data))
      return true
    }
    case 'COSIGN_POST_JOIN_RELAY': {
      const req = message.payload as import('@latch/types').CosignCompleteMemberJoinRequest
      const { accounts } = await getAccounts()
      const linked = accounts.find((a) => a.id === req.linkedAccountId)
      if (!linked) throw new Error('Linked account not found')
      const signerBytes = await signerPublicKeyBytesForAccount(linked)
      const memberBlindId = await deriveMemberBlindId(signerBytes)
      const wallet = linked.smartAccountAddress
      await postJoinRelay(wallet, {
        invite_token: req.inviteToken,
        transport_pubkey_b64: req.transportPubkeyB64,
        member_blind_id: memberBlindId,
      })
      sendResponse(ok({ message: 'ok' }))
      return true
    }
    case 'COSIGN_POLL_JOIN_RELAY': {
      const req = message.payload as import('@latch/types').CosignPollJoinRelayRequest
      const { accounts, activeAccountId } = await getAccounts()
      const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0]
      if (!active) {
        sendResponse(ok(null))
        return true
      }
      const relay = await getJoinRelay(active.smartAccountAddress, req.inviteToken)
      sendResponse(ok(relay))
      return true
    }
    case 'COSIGN_SEAL_MEMBER_WCK': {
      const req = message.payload as import('@latch/types').CosignSealMemberWckRequest
      const record = await getCosignRecordForWallet(req.walletRef)
      if (!record) throw new Error('WCK record not found for wallet')
      await announceMemberForWallet({
        walletRef: req.walletRef,
        wckHex: record.wckHex,
        memberBlindIds: [req.memberBlindId],
        transportPubkeyB64: req.transportPubkeyB64,
      })
      await deleteJoinRelay(req.walletRef, req.inviteToken)
      sendResponse(ok({ message: 'ok' }))
      return true
    }
    case 'COSIGN_DISCOVER_MEMBERSHIPS': {
      const req = message.payload as import('@latch/types').CosignDiscoverRequest
      const { accounts } = await getAccounts()
      const linked = accounts.find((a) => a.id === req.linkedAccountId)
      if (!linked) throw new Error('Linked account not found')
      const data = await discoverMembershipsForAccount(linked)
      sendResponse(ok(data))
      return true
    }
    case 'COSIGN_LIST_PENDING': {
      const req = message.payload as import('@latch/types').CosignListPendingRequest
      const record = await getCosignRecordForWallet(req.smartAccountAddress)
      if (!record) {
        sendResponse(ok({ requests: [] }))
        return true
      }
      const queueIndex = await deriveQueueIndex(wckBytesFromRecord(record), req.smartAccountAddress)
      const requests = await listPendingCosignRequests(req.smartAccountAddress, queueIndex)
      sendResponse(ok({ requests }))
      return true
    }
    case 'COSIGN_GET_REQUEST': {
      const req = message.payload as import('@latch/types').CosignGetRequestPayload
      const { accounts, activeAccountId } = await getAccounts()
      const active =
        accounts.find((a) => a.mode === 'multisig' && a.id === activeAccountId) ??
        accounts.find((a) => a.mode === 'multisig')
      const wallet = active?.smartAccountAddress ?? ''
      const data = await getCosignRequest(wallet, req.requestId)
      sendResponse(ok(data))
      return true
    }
    case 'COSIGN_PROPOSE': {
      const req = message.payload as import('@latch/types').CosignProposeRequest
      const record = await getCosignRecordForWallet(req.smartAccountAddress)
      if (!record) throw new Error('Cosign wallet record not found')
      const queueIndex = await deriveQueueIndex(wckBytesFromRecord(record), req.smartAccountAddress)
      const data = await createCosignRequest(req.smartAccountAddress, {
        queueIndex,
        unsignedTxXdr: req.unsignedTxXdr,
        network: req.network,
        threshold: req.threshold,
      })
      sendResponse(ok(data))
      return true
    }
    case 'COSIGN_SIGN_REQUEST': {
      const req = message.payload as import('@latch/types').CosignSignRequest
      const record = await getCosignRecordForWallet(req.smartAccountAddress)
      if (!record) throw new Error('Cosign wallet record not found')
      const { accounts } = await getAccounts()
      const linked = accounts.find((a) => a.id === req.linkedAccountId)
      if (!linked) throw new Error('Linked signer account not found')
      const signerBytes = await signerPublicKeyBytesForAccount(linked)
      const blindSignerId = await deriveBlindSignerId(wckBytesFromRecord(record), signerBytes)
      const authEntryXdr = req.signedAuthEntryBase64?.trim()
      if (!authEntryXdr) throw new Error('signedAuthEntryBase64 required')
      const data = await addCosignSignature(
        req.smartAccountAddress,
        req.requestId,
        blindSignerId,
        authEntryXdr
      )
      sendResponse(ok(data))
      return true
    }
    case 'COSIGN_EXECUTE_REQUEST': {
      const req = message.payload as import('@latch/types').CosignExecuteRequest
      const record = await getCosignRecordForWallet(req.smartAccountAddress)
      if (!record) throw new Error('Cosign wallet record not found')
      const request = await getCosignRequest(req.smartAccountAddress, req.requestId)
      const { accounts } = await getAccounts()
      const linked = accounts.find((a) => a.id === record.linkedSignerAccountId)
      const result = await assembleAndSubmitCosignRequest({
        walletRef: req.smartAccountAddress,
        request,
        keyDataHex: linked?.passkeyKeyDataHex,
      })
      const updated = await getCosignRequest(req.smartAccountAddress, req.requestId)
      sendResponse(ok({ txHash: result.txHash, request: updated }))
      return true
    }
    case 'COSIGN_CANCEL_REQUEST': {
      const req = message.payload as import('@latch/types').CosignGetRequestPayload
      const { accounts } = await getAccounts()
      const ms = accounts.find((a) => a.mode === 'multisig')
      const wallet = ms?.smartAccountAddress ?? ''
      const data = await cancelCosignRequest(wallet, req.requestId)
      sendResponse(ok(data))
      return true
    }
    case 'COSIGN_GET_WCK_RECORD': {
      const req = message.payload as { walletRef: string }
      const record = await getCosignRecordForWallet(req.walletRef)
      sendResponse(ok(record ?? null))
      return true
    }
    case 'COSIGN_ENSURE_V1_AUTH': {
      const req = message.payload as { linkedAccountId: string }
      const { accounts } = await getAccounts()
      const linked = accounts.find((a) => a.id === req.linkedAccountId)
      if (!linked) throw new Error('Linked account not found')
      const { wallet } = v1AuthWalletForLinkedAccount(linked)
      await resolveAccessToken(wallet)
      sendResponse(ok({ ok: true }))
      return true
    }
    case 'COSIGN_V1_AUTH_CHALLENGE': {
      const req = message.payload as { linkedAccountId: string }
      const { accounts } = await getAccounts()
      const linked = accounts.find((a) => a.id === req.linkedAccountId)
      if (!linked) throw new Error('Linked account not found')
      const { wallet, keyType } = v1AuthWalletForLinkedAccount(linked)
      const challenge = await requestWalletChallenge(wallet, keyType)
      const nonce = String(challenge.nonce ?? challenge.challenge ?? '').trim()
      if (!nonce) throw new Error('V1 auth challenge missing nonce')
      sendResponse(ok({ wallet, nonce, keyType }))
      return true
    }
    case 'COSIGN_V1_AUTH_SIGN_IN': {
      const req = message.payload as {
        linkedAccountId: string
        wallet: string
        keyType: string
        nonce: string
        response: unknown
      }
      const { accounts } = await getAccounts()
      const linked = accounts.find((a) => a.id === req.linkedAccountId)
      if (!linked) throw new Error('Linked account not found')
      await completeWalletSignInFromAssertion({
        wallet: req.wallet,
        keyType: req.keyType,
        nonce: req.nonce,
        assertion: req.response,
        keyDataHex: linked.passkeyKeyDataHex,
      })
      sendResponse(ok({ ok: true }))
      return true
    }
    case 'COSIGN_CREATE_LOCAL_ACCOUNT': {
      const payload = message.payload as {
        walletRef: string
        label: string
        threshold: number
        wckRecordId: string
        linkedAccountId: string
        cosignBlindSignerId: string
        accountSaltHex?: string
        membersSnapshot?: import('@latch/types').CosignMemberInit[]
      }
      const { account, activeAccountId } = await createAccount({
        mode: 'multisig',
        smartAccountAddress: payload.walletRef,
        label: payload.label,
        multisigThreshold: payload.threshold,
        cosignWckRefId: payload.wckRecordId,
        cosignBlindSignerId: payload.cosignBlindSignerId,
        cosignLinkedAccountId: payload.linkedAccountId,
        multisigAccountSaltHex: payload.accountSaltHex,
        multisigMembersSnapshot: payload.membersSnapshot,
      })
      sendResponse(ok({ account, activeAccountId }))
      return true
    }
    case 'COSIGN_GET_PROPOSALS_BANNER_DISMISSED': {
      const res = await chrome.storage.local.get('latch.cosignProposalsBannerDismissed')
      const accountIds = (res.latch.cosignProposalsBannerDismissed as string[] | undefined) ?? []
      sendResponse(ok({ accountIds }))
      return true
    }
    case 'COSIGN_DISMISS_PROPOSALS_BANNER': {
      const req = message.payload as { accountId: string }
      const res = await chrome.storage.local.get('latch.cosignProposalsBannerDismissed')
      const prev = (res.latch.cosignProposalsBannerDismissed as string[] | undefined) ?? []
      const accountIds = prev.includes(req.accountId) ? prev : [...prev, req.accountId]
      await chrome.storage.local.set({ 'latch.cosignProposalsBannerDismissed': accountIds })
      sendResponse(ok({ accountIds }))
      return true
    }
    case 'COSIGN_PREDICT_ACCOUNT': {
      const req = message.payload as {
        threshold: number
        signers: import('@latch/types').MultisigSignerInitRequest[]
        accountSaltHex: string
      }
      const data = await predictMultisigAccountFromSigners(req)
      sendResponse(ok(data))
      return true
    }
    case 'COSIGN_PREPARE_SIGN': {
      const req = message.payload as {
        unsignedTxXdr: string
        smartAccountAddress: string
        linkedAccountId: string
      }
      const { accounts } = await getAccounts()
      const linked = accounts.find((a) => a.id === req.linkedAccountId)
      if (!linked) throw new Error('Linked account not found')
      const signerType = linked.mode === 'passkey' ? 'passkey' : 'delegated'
      const data = await prepareSign({
        network: await getActiveNetwork(),
        smartAccountAddress: req.smartAccountAddress,
        unsignedTxXdr: req.unsignedTxXdr,
        signerType,
        signerG: linked.gAddress,
      })
      sendResponse(ok(data))
      return true
    }
    case 'COSIGN_ATTACH_WEBAUTHN_AUTH': {
      const req = message.payload as {
        unsignedTxXdr: string
        sigDataXdrHex: string
        keyDataHex: string
        contextRuleId: number
        authEntryXdr: string
      }
      try {
        const attached = await latchFetch<{
          auth_entry_xdr?: string
          signedAuthEntryBase64?: string
        }>('/api/transaction/attach-auth-webauthn', {
          method: 'POST',
          body: latchExtensionJsonBody(
            await withActiveNetwork({
              unsignedTxXdr: req.unsignedTxXdr,
              authEntryXdr: req.authEntryXdr,
              sigDataXdrHex: req.sigDataXdrHex,
              keyDataHex: req.keyDataHex,
              contextRuleId: req.contextRuleId,
            })
          ),
        })
        const signed = attached.signedAuthEntryBase64 ?? attached.auth_entry_xdr ?? req.authEntryXdr
        sendResponse(ok({ signedAuthEntryBase64: signed }))
        return true
      } catch {
        await submitTxWebauthn({
          txXdr: req.unsignedTxXdr,
          authEntryXdr: req.authEntryXdr,
          sigDataXdr: req.sigDataXdrHex,
          keyDataHex: req.keyDataHex,
          contextRuleId: req.contextRuleId,
        })
        sendResponse(ok({ signedAuthEntryBase64: req.authEntryXdr }))
        return true
      }
    }
    case 'COSIGN_RUN_POLL': {
      const notified = await runCosignPollCycle()
      sendResponse(ok({ notified }))
      return true
    }
    default:
      return false
  }
}
