/** Test-only builders for Soroban auth entries (not exported from the package index). */

import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'

export function authInvocation(
  contractId: string,
  fn: string,
  subInvocations: xdr.SorobanAuthorizedInvocation[] = []
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: fn,
        args: [],
      })
    ),
    subInvocations,
  })
}

export function createContractInvocation(creator: string): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
      new xdr.CreateContractArgs({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: new Address(creator).toScAddress(),
            salt: Buffer.alloc(32),
          })
        ),
        executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
      })
    ),
    subInvocations: [],
  })
}

export function authEntry(
  signer: string,
  rootInvocation: xdr.SorobanAuthorizedInvocation
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation,
  })
}

/** Unsigned tx with one invokeHostFunction op per `[contractId, fn]` pair. */
export function invokeTxXdr(
  calls: Array<[contractId: string, fn: string]>,
  passphrase: string = Networks.TESTNET
): string {
  const account = new Account(Keypair.random().publicKey(), '1')
  const builder = new TransactionBuilder(account, { fee: '100', networkPassphrase: passphrase })
  for (const [contractId, fn] of calls) {
    builder.addOperation(new Contract(contractId).call(fn, nativeToScVal(1, { type: 'u32' })))
  }
  return builder.setTimeout(30).build().toXDR()
}

/** Attaches auth entries to the (single) invokeHostFunction op of an unsigned tx. */
export function withAuth(txXdr: string, entries: xdr.SorobanAuthorizationEntry[]): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(txXdr, 'base64')
  const op = envelope.v1().tx().operations()[0]!
  op.body().invokeHostFunctionOp().auth(entries)
  return envelope.toXDR('base64')
}
