import type { BuildSendTxResponse, SerializableError, SmartAccountBalanceRow } from '@latch/types'

/** Summary-screen pre-build. `null` when no estimate applies (e.g. multisig proposals). */
export type SendFeeEstimate =
  | { ok: true; data: BuildSendTxResponse }
  | { ok: false; error: SerializableError }
  | null

export type SendStep =
  | 'selectToken'
  | 'selectRecipient'
  | 'enterAmount'
  | 'summary'
  | 'success'
  | 'failure'
  | 'receipt'

export type SendInputMode = 'crypto' | 'fiat'

export type SendDraft = {
  token: SmartAccountBalanceRow | null
  recipientAddress: string
  recipientName?: string
  amount: string
  inputMode: SendInputMode
  memo?: string
}

export type SendResult = {
  status: 'success' | 'failure'
  hash?: string
  proposalId?: string
  errorMessage?: string
  submittedAt?: string
}

export const INITIAL_SEND_DRAFT: SendDraft = {
  token: null,
  recipientAddress: '',
  amount: '',
  inputMode: 'crypto',
}
