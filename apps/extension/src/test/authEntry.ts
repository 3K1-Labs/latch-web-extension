import { Address, xdr } from '@stellar/stellar-sdk'

export type AuthCall = { contractId: string; fn: string; subs?: AuthCall[] }

/** Some contract that is not the test wallet. */
export const OTHER_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

function invocation(call: AuthCall): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(call.contractId).toScAddress(),
        functionName: call.fn,
        args: [],
      })
    ),
    subInvocations: (call.subs ?? []).map(invocation),
  })
}

/** A base64 SorobanAuthorizationEntry for `signer` authorizing `root`. */
export function authEntryXdr(signer: string, root: AuthCall): string {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: invocation(root),
  }).toXDR('base64')
}
