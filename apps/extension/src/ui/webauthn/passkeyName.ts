import type { PasskeyConfirmSeqRequest, PasskeyNextSeqResponse, StoredAccount } from '@latch/types'

import { sendToBackground } from '../lib/backgroundClient'

/**
 * WebAuthn `user.name` / `user.displayName` for a Latch passkey.
 *
 * Shared convention with latch-mobile (`buildPasskeyName` in
 * `src/lib/provision-passkey.ts`): one vocabulary across clients, because once
 * every client registers under the same RP domain a user's mobile and
 * extension passkeys are filed under the same heading in iCloud Keychain /
 * Google Password Manager. Both WebAuthn fields get this same string — the
 * sign-in picker shows `displayName`, but the passkey *management* screen shows
 * `user.name`, so a slug in either one makes the list unreadable.
 *
 * `seq` is a stored monotonic counter, never the account-list length: deleting
 * a wallet and creating another must not mint a second passkey with a number
 * the picker is already showing.
 */
export function buildPasskeyName(seq: number, accountLabel?: string): string {
  const label = accountLabel?.trim()
  return label ? `${label} (Latch ${seq})` : `Latch Wallet ${seq}`
}

/** Passkey name for a specific flow, e.g. `Latch Wallet 3 · multisig join`. */
export function buildPasskeyRegistrationName(
  seq: number,
  accountLabel?: string,
  context?: string
): string {
  const base = buildPasskeyName(seq, accountLabel)
  const ctx = context?.trim()
  return ctx ? `${base} · ${ctx}` : base
}

/** Next sequence number derived the old way, for when the background peek fails. */
function fallbackSeqFromAccounts(accounts: StoredAccount[] | undefined): number {
  const passkeyCount = (accounts ?? []).reduce((n, a) => n + (a.mode === 'passkey' ? 1 : 0), 0)
  return passkeyCount + 1
}

export type ReservedPasskeyName = {
  seq: number
  displayName: string
  /** Call once the passkey exists, so the number is never handed out again. */
  commit: () => Promise<void>
}

/**
 * Reserve the name for a passkey that is about to be created.
 *
 * The number is only *peeked* here: registration begin is prefetched when a
 * create screen mounts and re-run on every retry, so advancing the counter at
 * this point would burn numbers on ceremonies the user never completes. The
 * returned `commit` records the number after the passkey actually exists.
 */
export async function reservePasskeyName(args: {
  accountLabel?: string
  context?: string
  /** Used only if the background counter is unreachable. */
  fallbackAccounts?: StoredAccount[]
}): Promise<ReservedPasskeyName> {
  let seq: number | undefined
  try {
    const res = await sendToBackground<undefined, PasskeyNextSeqResponse>({
      type: 'PASSKEY_NEXT_SEQ',
      payload: undefined,
    })
    if (res.ok && typeof res.data?.seq === 'number' && res.data.seq > 0) {
      seq = res.data.seq
    }
  } catch {
    // fall through to the account-derived number
  }

  if (seq === undefined) {
    // The label is cosmetic; never block wallet creation over it.
    seq = fallbackSeqFromAccounts(args.fallbackAccounts)
    console.warn(
      '[latch/passkey] Could not read the stored passkey counter; naming this passkey from the ' +
        'local account count instead. The number may repeat one already in the credential manager.'
    )
  }

  const reservedSeq = seq
  return {
    seq: reservedSeq,
    displayName: buildPasskeyRegistrationName(reservedSeq, args.accountLabel, args.context),
    commit: async () => {
      try {
        await sendToBackground<PasskeyConfirmSeqRequest, undefined>({
          type: 'PASSKEY_CONFIRM_SEQ',
          payload: { seq: reservedSeq },
        })
      } catch {
        // The passkey exists either way; a lost commit only risks a repeated number.
      }
    },
  }
}
