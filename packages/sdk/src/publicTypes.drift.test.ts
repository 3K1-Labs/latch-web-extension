import { describe, expect, it } from 'vitest'

import type {
  Network as MonorepoNetwork,
  OpenSignRequestParams as MonorepoOpenSignRequestParams,
  Sep0043Error as MonorepoSep0043Error,
  Sep0043ErrorCode as MonorepoSep0043ErrorCode,
  Sep0043GetAddressResponse as MonorepoSep0043GetAddressResponse,
  Sep0043GetNetworkResponse as MonorepoSep0043GetNetworkResponse,
  Sep0043SignTransactionOptions as MonorepoSep0043SignTransactionOptions,
  Sep0043SignTransactionResponse as MonorepoSep0043SignTransactionResponse,
  SignTransactionRequest as MonorepoSignTransactionRequest,
  SignTransactionResponse as MonorepoSignTransactionResponse,
} from '@latch/types'

import type {
  Network,
  OpenSignRequestParams,
  Sep0043Error,
  Sep0043ErrorCode,
  Sep0043GetAddressResponse,
  Sep0043GetNetworkResponse,
  Sep0043SignTransactionOptions,
  Sep0043SignTransactionResponse,
  SignTransactionRequest,
  SignTransactionResponse,
} from './publicTypes.js'

type ExpectEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type Assert<T extends true> = T

type _publicTypesMatchMonorepo = [
  Assert<ExpectEqual<Network, MonorepoNetwork>>,
  Assert<ExpectEqual<OpenSignRequestParams, MonorepoOpenSignRequestParams>>,
  Assert<ExpectEqual<Sep0043Error, MonorepoSep0043Error>>,
  Assert<ExpectEqual<Sep0043ErrorCode, MonorepoSep0043ErrorCode>>,
  Assert<ExpectEqual<Sep0043GetAddressResponse, MonorepoSep0043GetAddressResponse>>,
  Assert<ExpectEqual<Sep0043GetNetworkResponse, MonorepoSep0043GetNetworkResponse>>,
  Assert<ExpectEqual<Sep0043SignTransactionOptions, MonorepoSep0043SignTransactionOptions>>,
  Assert<ExpectEqual<Sep0043SignTransactionResponse, MonorepoSep0043SignTransactionResponse>>,
  Assert<ExpectEqual<SignTransactionRequest, MonorepoSignTransactionRequest>>,
  Assert<ExpectEqual<SignTransactionResponse, MonorepoSignTransactionResponse>>,
]

void (0 as unknown as _publicTypesMatchMonorepo)

describe('public types', () => {
  it('stays aligned with @latch/types at compile time', () => {
    expect(true).toBe(true)
  })
})
