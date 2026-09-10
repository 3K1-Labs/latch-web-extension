/**
 * Soroban auth-entry helpers for enforcing re-simulation (issue #61).
 * No Chrome / no secrets — pure XDR transforms.
 */

import { Address, StrKey, Transaction, xdr } from '@stellar/stellar-sdk'

/** Recursively count invocation nodes (root + every sub-invocation). */
export function countAuthContexts(inv: xdr.SorobanAuthorizedInvocation): number {
  let n = 1
  for (const sub of inv.subInvocations()) {
    n += countAuthContexts(sub)
  }
  return n
}

/** Repeat `ruleId` once per auth-context node in the entry's invocation tree. */
export function contextRuleIdsForEntry(
  entry: xdr.SorobanAuthorizationEntry,
  ruleId: number
): number[] {
  const count = countAuthContexts(entry.rootInvocation())
  return Array.from({ length: count }, () => ruleId)
}

/**
 * AuthPayload { context_rule_ids, signers: Map<External(verifier, keyData), sigData> }
 * for a WebAuthn / passkey signer.
 */
export function buildWebAuthnAuthPayload(
  verifierAddress: string,
  keyDataHex: string,
  sigDataXdr: Uint8Array,
  contextRuleIds: number[]
): xdr.ScVal {
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    xdr.ScVal.scvAddress(Address.fromString(verifierAddress).toScAddress()),
    xdr.ScVal.scvBytes(Buffer.from(keyDataHex, 'hex')),
  ])

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('context_rule_ids'),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('signers'),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerKey,
          val: xdr.ScVal.scvBytes(Buffer.from(sigDataXdr)),
        }),
      ]),
    }),
  ])
}

/**
 * AuthPayload { context_rule_ids, signers: Map<Delegated(G), empty Bytes> }
 * for a mnemonic / Freighter G-address signer.
 */
export function buildDelegatedAuthPayload(gAddress: string, contextRuleIds: number[]): xdr.ScVal {
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Delegated'),
    xdr.ScVal.scvAddress(Address.fromString(gAddress).toScAddress()),
  ])

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('context_rule_ids'),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('signers'),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerKey,
          val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
        }),
      ]),
    }),
  ])
}

/** Set (or clear) the address-credential signature ScVal on an auth entry. */
export function setAddressAuthSignature(
  entry: xdr.SorobanAuthorizationEntry,
  signature: xdr.ScVal
): xdr.SorobanAuthorizationEntry {
  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
  const creds = clone.credentials()
  if (creds.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    throw new Error('Expected address credentials on auth entry')
  }
  creds.address().signature(signature)
  return clone
}

/**
 * Inject a raw 64-byte Ed25519 signature into a G-address auth entry template
 * (classic-account `{public_key, signature}` shape).
 */
export function applyDelegatedGSignature(
  entryTemplate: xdr.SorobanAuthorizationEntry,
  rawSignature64: Uint8Array,
  signerG: string
): xdr.SorobanAuthorizationEntry {
  if (rawSignature64.length !== 64) {
    throw new Error(`Expected 64-byte Ed25519 signature, got ${rawSignature64.length} bytes`)
  }
  const pubKey = StrKey.decodeEd25519PublicKey(signerG)
  const sigScVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('public_key'),
        val: xdr.ScVal.scvBytes(Buffer.from(pubKey)),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('signature'),
        val: xdr.ScVal.scvBytes(Buffer.from(rawSignature64)),
      }),
    ]),
  ])
  return setAddressAuthSignature(entryTemplate, sigScVal)
}

function isVoidOrEmptySignature(sig: xdr.ScVal | null | undefined): boolean {
  if (sig == null) return true
  try {
    if (sig.switch() === xdr.ScValType.scvVoid()) return true
  } catch {
    return true
  }
  return false
}

/** True when any address-credential auth entry already carries a non-void signature. */
export function txHasSignedAddressAuth(tx: Transaction): boolean {
  for (const entry of extractInvokeHostAuth(tx)) {
    const creds = entry.credentials()
    if (creds.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) continue
    if (!isVoidOrEmptySignature(creds.address().signature())) return true
  }
  return false
}

/** Read auth entries from the first InvokeHostFunction operation. */
export function extractInvokeHostAuth(tx: Transaction): xdr.SorobanAuthorizationEntry[] {
  const op = tx.operations[0]
  if (!op || op.type !== 'invokeHostFunction') return []
  const auth = 'auth' in op && Array.isArray(op.auth) ? op.auth : []
  return auth as xdr.SorobanAuthorizationEntry[]
}

/**
 * Replace the first InvokeHostFunction op's auth array at the XDR level.
 * Required after `assembleTransaction`, which rewrites op.auth from its sim
 * recommendation and can drop the signed nonce/expiration/signatures.
 */
export function replaceInvokeHostAuth(
  tx: Transaction,
  entries: xdr.SorobanAuthorizationEntry[],
  networkPassphrase: string
): Transaction {
  const env = xdr.TransactionEnvelope.fromXDR(tx.toXDR(), 'base64')
  if (env.switch() !== xdr.EnvelopeType.envelopeTypeTx()) {
    throw new Error(`Expected v1 tx envelope, got ${env.switch().name}`)
  }
  const ops = env.v1().tx().operations()
  if (ops.length === 0) throw new Error('Transaction has no operations')
  const body = ops[0]!.body()
  if (body.switch() !== xdr.OperationType.invokeHostFunction()) {
    throw new Error(`Expected invokeHostFunction op, got ${body.switch().name}`)
  }
  body.invokeHostFunctionOp().auth(entries)
  return new Transaction(env, networkPassphrase)
}
