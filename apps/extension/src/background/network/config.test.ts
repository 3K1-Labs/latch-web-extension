import { afterEach, describe, expect, it } from 'vitest'

import { FEE_FORWARDER_CONTRACT_ID } from '@latch/stellar'

import { feeForwarderContractIdFor } from './config'

const TESTNET_KEY = 'PLASMO_PUBLIC_FEE_FORWARDER_CONTRACT_ID'
const MAINNET_KEY = 'PLASMO_PUBLIC_FEE_FORWARDER_CONTRACT_ID_MAINNET'
const ENV_ID = 'CENVOVERRIDE'

describe('feeForwarderContractIdFor', () => {
  afterEach(() => {
    delete process.env[TESTNET_KEY]
    delete process.env[MAINNET_KEY]
  })

  it('falls back to the known testnet FeeForwarder when the env var is unset', () => {
    expect(feeForwarderContractIdFor('testnet')).toBe(FEE_FORWARDER_CONTRACT_ID.testnet)
    expect(feeForwarderContractIdFor('testnet')).toBeTruthy()
  })

  it('stays undefined on mainnet when the env var is unset (never the testnet id)', () => {
    expect(feeForwarderContractIdFor('mainnet')).toBeUndefined()
  })

  it('lets the env var override the constant per network', () => {
    process.env[TESTNET_KEY] = ` ${ENV_ID} `
    process.env[MAINNET_KEY] = ENV_ID
    expect(feeForwarderContractIdFor('testnet')).toBe(ENV_ID)
    expect(feeForwarderContractIdFor('mainnet')).toBe(ENV_ID)
  })

  it('ignores a value that is not a contract id', () => {
    process.env[TESTNET_KEY] = 'GNOTACONTRACT'
    process.env[MAINNET_KEY] = 'GNOTACONTRACT'
    expect(feeForwarderContractIdFor('testnet')).toBe(FEE_FORWARDER_CONTRACT_ID.testnet)
    expect(feeForwarderContractIdFor('mainnet')).toBeUndefined()
  })
})
