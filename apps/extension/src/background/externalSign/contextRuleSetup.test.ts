import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { describe, expect, it, vi } from 'vitest'
import { SOROSWAP_CONFIG } from '@latch/swap'

import type { StoredAccount } from '@latch/types'

vi.mock('../network/config', () => ({
  networkPassphraseFor: (network: 'testnet' | 'mainnet') =>
    network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
}))

vi.mock('../../ui/lib/latchEnv', () => ({
  webauthnVerifierAddressFromEnv: () => 'CVERIFIER123',
}))

import { CONTEXT_RULE_SETUP_UNSUPPORTED, resolveExternalSignContextSetup } from './contextRuleSetup'

const SMART = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

const PASSKEY_ACCOUNT = {
  id: 'acc-1',
  mode: 'passkey',
  smartAccountAddress: SMART,
  passkeyKeyDataHex: 'ab12',
  passkeyCredentialId: 'cred-1',
} as unknown as StoredAccount

function txBuilder() {
  const source = new Account(Keypair.random().publicKey(), '1')
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
}

function sacTransferXdr(sacContractId: string): string {
  const contract = new Contract(sacContractId)
  return txBuilder()
    .addOperation(
      contract.call(
        'transfer',
        new Address(SMART).toScVal(),
        new Address(Keypair.random().publicKey()).toScVal(),
        nativeToScVal(10n, { type: 'i128' })
      )
    )
    .setTimeout(30)
    .build()
    .toXDR()
}

function invokeXdr(contractId: string, fn: string): string {
  const contract = new Contract(contractId)
  return txBuilder()
    .addOperation(contract.call(fn, nativeToScVal(1, { type: 'u32' })))
    .setTimeout(30)
    .build()
    .toXDR()
}

describe('resolveExternalSignContextSetup', () => {
  it('maps a native SAC transfer to setup-send-rules for native', () => {
    const xdr = sacTransferXdr(Asset.native().contractId(Networks.TESTNET))

    const setup = resolveExternalSignContextSetup({
      unsignedTxXdr: xdr,
      network: 'testnet',
      account: PASSKEY_ACCOUNT,
    })

    expect(setup.kind).toBe('send')
    expect(setup.body).toMatchObject({
      smartAccountAddress: SMART,
      signerType: 'passkey',
      network: 'testnet',
      assetId: 'native',
      keyDataHex: 'ab12',
      credentialId: 'cred-1',
    })
  })

  it('maps a catalog USDC transfer to that asset, never the whole catalog', () => {
    const usdc = new Asset('USDC', TESTNET_USDC_ISSUER).contractId(Networks.TESTNET)

    const setup = resolveExternalSignContextSetup({
      unsignedTxXdr: sacTransferXdr(usdc),
      network: 'testnet',
      account: PASSKEY_ACCOUNT,
    })

    expect(setup.kind).toBe('send')
    expect(setup.body).toMatchObject({ assetId: 'USDC' })
  })

  it('maps a known swap router to setup-swap-rules', () => {
    const router = SOROSWAP_CONFIG.testnet.routerContractId

    const setup = resolveExternalSignContextSetup({
      unsignedTxXdr: invokeXdr(router, 'swap'),
      network: 'testnet',
      account: PASSKEY_ACCOUNT,
    })

    expect(setup.kind).toBe('swap')
    expect(setup.body).toMatchObject({
      providerId: 'soroswap',
      routerContractId: router,
      signerType: 'passkey',
    })
  })

  it('uses the delegated G address for seed accounts', () => {
    const gAddress = Keypair.random().publicKey()

    const setup = resolveExternalSignContextSetup({
      unsignedTxXdr: sacTransferXdr(Asset.native().contractId(Networks.TESTNET)),
      network: 'testnet',
      account: {
        id: 'acc-2',
        mode: 'mnemonic',
        smartAccountAddress: SMART,
        gAddress,
      } as unknown as StoredAccount,
    })

    expect(setup.body.signerType).toBe('freighter')
    expect(setup.body.gAddress).toBe(gAddress)
    expect(setup.body.keyDataHex).toBeUndefined()
  })

  it('fails closed for an unknown contract call', () => {
    const unknown = new Asset('FOO', TESTNET_USDC_ISSUER).contractId(Networks.TESTNET)

    expect(() =>
      resolveExternalSignContextSetup({
        unsignedTxXdr: invokeXdr(unknown, 'mint'),
        network: 'testnet',
        account: PASSKEY_ACCOUNT,
      })
    ).toThrowError(expect.objectContaining({ code: CONTEXT_RULE_SETUP_UNSUPPORTED }))
  })

  it('fails closed for an unparsable XDR', () => {
    expect(() =>
      resolveExternalSignContextSetup({
        unsignedTxXdr: 'not-xdr',
        network: 'testnet',
        account: PASSKEY_ACCOUNT,
      })
    ).toThrowError(expect.objectContaining({ code: CONTEXT_RULE_SETUP_UNSUPPORTED }))
  })

  it('reports a passkey prerequisite instead of posting setup without key data', () => {
    expect(() =>
      resolveExternalSignContextSetup({
        unsignedTxXdr: sacTransferXdr(Asset.native().contractId(Networks.TESTNET)),
        network: 'testnet',
        account: {
          id: 'acc-3',
          mode: 'passkey',
          smartAccountAddress: SMART,
        } as unknown as StoredAccount,
      })
    ).toThrowError(expect.objectContaining({ code: 'context_rule_setup_failed' }))
  })
})
