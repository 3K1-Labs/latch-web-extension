import type { SerializableError } from '@latch/types'

/**
 * Plain-language copy for the backup-signer API's stable error codes.
 *
 * These carry real consequences — an unauthorized add grants permanent spend
 * authority, and a bad removal can lock a wallet — so each one says what
 * happened and what the user can do, rather than surfacing the raw message.
 */
export function signerErrorMessage(error: SerializableError | undefined, fallback: string): string {
  switch (error?.code) {
    case 'not_a_signer':
      return 'This device has not proved it signs for this wallet. Verify with your current passkey and try again.'
    case 'unknown_account':
      return 'Latch does not recognize this smart account yet. Make sure it finished deploying.'
    case 'last_signer':
      return 'This is the wallet’s only signer. Removing it would lock the wallet permanently.'
    case 'signer_locked_out':
      return 'This is your only passkey for this wallet. Add a backup passkey before removing it.'
    case 'signer_id_unknown':
      return 'This signer was never fully set up, so it cannot be removed yet. Finish its setup first.'
    case 'no_default_rule':
      return 'This wallet has no default signing rule to update. Contact support before retrying.'
    case 'signer_added_index_failed':
      return 'The passkey was added on-chain, but saving it for recovery failed. Choose Finish setup to retry.'
    case 'validation_error':
      return 'The transaction has not settled yet. Wait a moment and choose Finish setup to retry.'
    default:
      return error?.message?.trim() || fallback
  }
}

/** True when the failure is only that this browser session lost its proof of ownership. */
export function signerErrorNeedsReverify(error: SerializableError | undefined): boolean {
  return error?.code === 'not_a_signer'
}
