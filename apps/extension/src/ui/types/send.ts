import type { BuildSendTxResponse, SerializableError, SmartAccountBalanceRow } from '@latch/types'

/** Error code for a one-time wallet setup that failed before Confirm could be enabled. */
export const SEND_SETUP_FAILED_CODE = 'setup_failed'

/** Summary-screen pre-build. `null` when no estimate applies (e.g. multisig proposals). */
export type SendFeeEstimate =
  | { ok: true; data: BuildSendTxResponse }
  | { ok: false; error: SerializableError }
  | null

/** Fetch the summary estimate; `onSettingUp` fires if first-time wallet setup has to run first. */
export type FetchSendFeeEstimate = (opts?: { onSettingUp?: () => void }) => Promise<SendFeeEstimate>

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
