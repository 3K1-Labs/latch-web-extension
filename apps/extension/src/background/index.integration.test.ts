import { describe, expect, it, vi } from 'vitest'

describe('background message routing (smoke)', () => {
  it('GET_SETUP_STATE returns default setupState=new', async () => {
    // Import registers chrome.runtime.onMessage listener.
    vi.resetModules()
    await import('./index')

    const res = await chrome.runtime.sendMessage({ type: 'GET_SETUP_STATE', payload: undefined })
    expect(res.ok).toBe(true)
    expect(res.data.setupState).toBe('new')
  })

  it('SET_SETUP_STATE then GET_SETUP_STATE reflects stored values', async () => {
    vi.resetModules()
    await import('./index')

    const setRes = await chrome.runtime.sendMessage({
      type: 'SET_SETUP_STATE',
      payload: { setupState: 'has_account', accountPublicKey: 'GABC' },
    })
    expect(setRes.ok).toBe(true)

    const getRes = await chrome.runtime.sendMessage({ type: 'GET_SETUP_STATE', payload: undefined })
    expect(getRes.ok).toBe(true)
    expect(getRes.data.setupState).toBe('has_account')
    expect(getRes.data.accountPublicKey).toBe('GABC')
  })

  it('self-heals setupState to has_account when accounts already exist', async () => {
    vi.resetModules()
    await chrome.storage.local.set({
      'latch.env.storageMigrated': true,
      'latch.env.prod.accounts.byNetwork': {
        mainnet: [
          {
            id: 'acct-1',
            mode: 'passkey',
            smartAccountAddress: 'GABC123',
            createdAt: 1,
          },
        ],
      },
      'latch.env.prod.activeAccountId.byNetwork': { mainnet: 'acct-1' },
    })

    await import('./index')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const getRes = await chrome.runtime.sendMessage({ type: 'GET_SETUP_STATE', payload: undefined })
    expect(getRes.ok).toBe(true)
    expect(getRes.data.setupState).toBe('has_account')
    expect(getRes.data.accountPublicKey).toBe('GABC123')
  })

  it('CANCEL_REQUEST returns ok synchronously', async () => {
    vi.resetModules()
    await import('./index')

    const res = await chrome.runtime.sendMessage({
      type: 'CANCEL_REQUEST',
      payload: { requestId: 'test-cancel-id' },
    })
    expect(res.ok).toBe(true)
  })
})
