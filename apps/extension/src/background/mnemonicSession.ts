import type { Keypair } from '@stellar/stellar-sdk'

/** In-memory signing keys for `mode: mnemonic` accounts (cleared on logout). */
const mnemonicKeypairsByAccountId = new Map<string, Keypair>()

export function registerMnemonicKeypair(accountId: string, keypair: Keypair) {
  mnemonicKeypairsByAccountId.set(accountId, keypair)
}

export function getMnemonicKeypair(accountId: string): Keypair | undefined {
  return mnemonicKeypairsByAccountId.get(accountId)
}

export function clearMnemonicSessionKeys() {
  mnemonicKeypairsByAccountId.clear()
}

export function clearMnemonicSessionKeyForAccount(accountId: string) {
  mnemonicKeypairsByAccountId.delete(accountId)
}
