import { BackendError } from '../api/client'

const CONFIRM_ATTEMPTS = 5
const CONFIRM_RETRY_DELAY_MS = 3_000

function isUnsettledError(e: unknown): boolean {
  // The API answers 400 `validation_error` both for "hasn't settled yet" and
  // for "that hash didn't do what you claim". Only the first is worth waiting
  // on, but both are safe to retry: confirm is idempotent and a genuine
  // mismatch simply fails again on the last attempt.
  return e instanceof BackendError && e.status === 400 && e.code === 'validation_error'
}

/**
 * Run a `/confirm` call, waiting out a transaction that hasn't settled yet.
 *
 * `submit-webauthn` normally polls to SUCCESS before returning, but it can
 * give up and report the transaction as still pending. Confirm is the call
 * that records `signer_id` and writes the recovery index, so abandoning it
 * would leave a signer that works on-chain but cannot restore a wallet.
 */
export async function confirmWithSettlementRetry<T>(
  run: () => Promise<T>,
  opts?: { attempts?: number; delayMs?: number }
): Promise<T> {
  const attempts = opts?.attempts ?? CONFIRM_ATTEMPTS
  const delayMs = opts?.delayMs ?? CONFIRM_RETRY_DELAY_MS

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run()
    } catch (e) {
      if (!isUnsettledError(e)) throw e
      lastError = e
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}
