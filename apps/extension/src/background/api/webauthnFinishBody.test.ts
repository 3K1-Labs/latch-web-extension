import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearCachedActiveNetwork, setCachedActiveNetwork } from '../network/config'
import { webauthnFinishBody } from './webauthn'

describe('webauthnFinishBody', () => {
  beforeEach(() => {
    clearCachedActiveNetwork()
  })

  afterEach(() => {
    clearCachedActiveNetwork()
  })

  it('includes the active network when the payload omits it', async () => {
    setCachedActiveNetwork('mainnet')
    const body = JSON.parse(await webauthnFinishBody({ displayName: 'Wallet' }, 'registration'))
    expect(body.network).toBe('mainnet')
    expect(body.displayName).toBe('Wallet')
  })

  it('keeps an explicit network on the payload', async () => {
    setCachedActiveNetwork('mainnet')
    const body = JSON.parse(await webauthnFinishBody({ network: 'testnet' }, 'authentication'))
    expect(body.network).toBe('testnet')
  })
})
