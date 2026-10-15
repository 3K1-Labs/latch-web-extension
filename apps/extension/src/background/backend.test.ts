import { describe, expect, it, vi } from 'vitest'
import {
  BackendError,
  buildSendTx,
  createOrConnectPasskey,
  passkeyAuthenticationBegin,
  passkeyAuthenticationFinish,
  passkeyRegistrationBegin,
  passkeyRegistrationFinish,
  setupSendRules,
  submitTxWebauthn,
} from './backend'

describe('background/backend', () => {
  it('maps non-2xx JSON error into BackendError with status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: false,
          status: 500,
          async text() {
            return JSON.stringify({ error: 'boom' })
          },
        } as any
      })
    )

    await expect(
      createOrConnectPasskey({ keyDataHex: 'aa', credentialId: 'cred' } as any)
    ).rejects.toMatchObject({
      name: 'BackendError',
      status: 500,
      message: 'boom',
    } satisfies Partial<BackendError>)
  })

  it('maps AbortError into BackendError(code=timeout)', async () => {
    vi.useFakeTimers()

    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('Aborted')
            ;(e as any).name = 'AbortError'
            reject(e)
          })
        })
      })
    )

    const p = createOrConnectPasskey({ keyDataHex: 'aa', credentialId: 'cred' } as any)
    const asserted = expect(p).rejects.toMatchObject({
      name: 'BackendError',
      code: 'timeout',
    } satisfies Partial<BackendError>)

    await vi.advanceTimersByTimeAsync(21_000)
    await asserted

    vi.useRealTimers()
  })

  it('passkey begin routes send chromeExtensionId when chrome.runtime.id is set', async () => {
    vi.stubGlobal('chrome', {
      ...globalThis.chrome,
      runtime: { ...globalThis.chrome.runtime, id: 'extid-abc' },
    })

    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse((init?.body as string) || '{}') as Record<string, unknown>)
        return {
          ok: true,
          async text() {
            return JSON.stringify({ options: { challenge: 'x' } })
          },
        } as any
      })
    )

    await passkeyRegistrationBegin({ displayName: 'n' })
    await passkeyAuthenticationBegin()

    expect(bodies[0]).toMatchObject({
      displayName: 'n',
      chromeExtensionId: 'extid-abc',
    })
    expect(bodies[1]).toMatchObject({
      chromeExtensionId: 'extid-abc',
    })

    vi.unstubAllGlobals()
  })

  it('passkey finish routes send chromeExtensionId when chrome.runtime.id is set', async () => {
    vi.stubGlobal('chrome', {
      ...globalThis.chrome,
      runtime: { ...globalThis.chrome.runtime, id: 'extid-xyz' },
    })

    const mockCredential = {
      id: 'Y2g',
      rawId: 'Y2g',
      type: 'public-key',
      response: {
        clientDataJSON: 'Y2Q',
        attestationObject: 'Y28',
      },
    }

    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse((init?.body as string) || '{}') as Record<string, unknown>)
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              credentialId: 'c',
              keyDataHex: '00',
              smartAccountAddress: 'S',
              deployed: false,
              alreadyDeployed: false,
            })
          },
        } as any
      })
    )

    await passkeyRegistrationFinish({ response: mockCredential })
    await passkeyAuthenticationFinish({
      response: {
        ...mockCredential,
        response: {
          clientDataJSON: 'Y2Q',
          authenticatorData: 'YQ',
          signature: 'c2ln',
        },
      },
    })

    expect(bodies[0]).toMatchObject({
      response: expect.objectContaining({ id: 'Y2g' }),
      chromeExtensionId: 'extid-xyz',
    })
    expect(bodies[0]?.network).toBeUndefined()
    expect(bodies[1]).toMatchObject({
      response: expect.objectContaining({ id: 'Y2g' }),
      chromeExtensionId: 'extid-xyz',
    })
    expect(bodies[1]?.network).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('submitTxWebauthn sends chromeExtensionId and omits network', async () => {
    vi.stubGlobal('chrome', {
      ...globalThis.chrome,
      runtime: { ...globalThis.chrome.runtime, id: 'ext-submit' },
    })

    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse((init?.body as string) || '{}') as Record<string, unknown>)
        return {
          ok: true,
          async text() {
            return JSON.stringify({ ok: true })
          },
        } as any
      })
    )

    await submitTxWebauthn({
      txXdr: 'x',
      authEntryXdr: 'y',
      sigDataXdr: 'z',
      keyDataHex: '00',
      contextRuleId: 0,
    })

    expect(bodies[0]).toMatchObject({
      txXdr: 'x',
      chromeExtensionId: 'ext-submit',
    })
    expect(bodies[0]?.network).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('maps 409 NO_CONTEXT_RULE body code into BackendError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: false,
          status: 409,
          async text() {
            return JSON.stringify({ error: 'Context rule required', code: 'NO_CONTEXT_RULE' })
          },
        } as any
      })
    )

    await expect(
      buildSendTx({
        smartAccountAddress: 'CADDR',
        signerType: 'passkey',
        recipient: 'GADDR',
        amount: '1',
        assetId: 'native',
      })
    ).rejects.toMatchObject({
      name: 'BackendError',
      status: 409,
      code: 'NO_CONTEXT_RULE',
    } satisfies Partial<BackendError>)

    vi.unstubAllGlobals()
  })

  it('buildSendTx POSTs to /api/transaction/build-send with JSON body', async () => {
    const urls: string[] = []
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url)
        bodies.push(JSON.parse((init?.body as string) || '{}') as Record<string, unknown>)
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              txXdr: 'tx',
              authEntryXdr: 'auth',
              authDigestHex: 'abc',
              contextRuleId: 1,
            })
          },
        } as any
      })
    )

    await buildSendTx({
      smartAccountAddress: 'CADDR',
      signerType: 'freighter',
      recipient: 'GADDR',
      amount: '2.5',
      assetId: 'usdc',
      signerG: 'G123',
    })

    expect(urls[0]).toContain('/api/transaction/build-send')
    expect(bodies[0]).toMatchObject({
      smartAccountAddress: 'CADDR',
      signerType: 'freighter',
      recipient: 'GADDR',
      amount: '2.5',
      assetId: 'usdc',
      signerG: 'G123',
    })
    expect(bodies[0]?.network).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('setupSendRules POSTs to /api/smart-account/setup-send-rules', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              txXdr: 'tx',
              authEntryXdr: 'auth',
              authDigestHex: 'abc',
              contextRuleId: 1,
              alreadyConfigured: false,
              remainingSetupCount: 0,
            })
          },
        } as any
      })
    )

    await setupSendRules({
      smartAccountAddress: 'CADDR',
      signerType: 'passkey',
      assetId: 'native',
      keyDataHex: '00',
      verifierAddress: 'CVERIFIER',
    })

    expect(urls[0]).toContain('/api/smart-account/setup-send-rules')

    vi.unstubAllGlobals()
  })
})
