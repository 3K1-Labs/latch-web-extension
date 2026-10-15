import { describe, expect, it } from 'vitest'

import { webauthnFinishBody } from './webauthn'

describe('webauthnFinishBody', () => {
  it('omits network so the deployment decides', async () => {
    const body = JSON.parse(await webauthnFinishBody({ displayName: 'Wallet' }, 'registration'))
    expect(body.network).toBeUndefined()
    expect(body.displayName).toBe('Wallet')
  })

  it('strips an explicit network from the payload', async () => {
    const body = JSON.parse(await webauthnFinishBody({ network: 'testnet' }, 'authentication'))
    expect(body.network).toBeUndefined()
  })
})
