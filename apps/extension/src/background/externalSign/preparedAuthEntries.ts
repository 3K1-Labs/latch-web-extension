import type { BuildSendTxResponse } from '@latch/types'

/** Every auth entry a prepare-sign response carries: all of them are candidates to be signed. */
export function preparedAuthEntryXdrs(prepared: BuildSendTxResponse): string[] {
  const all = [
    prepared.authEntryXdr,
    ...(prepared.authEntriesXdr ?? []),
    prepared.smartAccountAuthEntryXdr,
    prepared.gAddressEntryTemplateXdr,
  ]
  return [...new Set(all.filter((xdr): xdr is string => typeof xdr === 'string' && xdr !== ''))]
}
