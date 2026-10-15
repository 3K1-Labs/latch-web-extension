import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDeveloperMode, setDeveloperMode } from '../storage'
import { latchFetch } from './client'
import { latchApiBaseUrl, latchMarketApiBaseUrl } from './config'
import { applyDeveloperMode } from './developerMode'
import { v1Fetch } from './v1Client'

const STAGING = 'https://staging.example'
const PRODUCTION = 'https://latch-backend.onrender.com'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  } as Response
}

describe('developer mode API base', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('uses the production URL when developer mode is off', async () => {
    vi.stubEnv('PLASMO_PUBLIC_LATCH_API_URL', PRODUCTION)
    vi.stubEnv('PLASMO_PUBLIC_LATCH_STAGING_API_URL', STAGING)
    await setDeveloperMode(false)
    expect(await latchApiBaseUrl()).toBe(PRODUCTION)
  })

  it('uses the staging URL when developer mode is on', async () => {
    vi.stubEnv('PLASMO_PUBLIC_LATCH_API_URL', PRODUCTION)
    vi.stubEnv('PLASMO_PUBLIC_LATCH_STAGING_API_URL', STAGING)
    vi.stubEnv('PLASMO_PUBLIC_LATCH_MARKET_API_URL', `${PRODUCTION}/v1`)
    await setDeveloperMode(true)
    expect(await latchApiBaseUrl()).toBe(STAGING)
    expect(await latchMarketApiBaseUrl()).toBe(`${STAGING}/v1`)
  })

  it('does not fetch when developer mode is on and staging URL is empty', async () => {
    vi.stubEnv('PLASMO_PUBLIC_LATCH_STAGING_API_URL', '')
    await setDeveloperMode(true)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(latchApiBaseUrl()).rejects.toThrow(/PLASMO_PUBLIC_LATCH_STAGING_API_URL/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await getDeveloperMode()).toBe(true)
  })

  it('writes the flag only when health reports the required network', async () => {
    vi.stubEnv('PLASMO_PUBLIC_LATCH_API_URL', PRODUCTION)
    vi.stubEnv('PLASMO_PUBLIC_LATCH_STAGING_API_URL', STAGING)
    await setDeveloperMode(false)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe(`${STAGING}/health`)
        return jsonResponse({ status: 'ok', network: 'testnet' })
      })
    )
    await applyDeveloperMode(true)
    expect(await getDeveloperMode()).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'ok', network: 'testnet' }))
    )
    await expect(applyDeveloperMode(false)).rejects.toThrow(/mainnet/)
    expect(await getDeveloperMode()).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe(`${PRODUCTION}/health`)
        return jsonResponse({ status: 'ok', network: 'mainnet' })
      })
    )
    await applyDeveloperMode(false)
    expect(await getDeveloperMode()).toBe(false)
  })

  it('leaves the flag unchanged when health times out', async () => {
    vi.useFakeTimers()
    vi.stubEnv('PLASMO_PUBLIC_LATCH_STAGING_API_URL', STAGING)
    await setDeveloperMode(false)
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('Aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
      })
    )
    const pending = applyDeveloperMode(true)
    const asserted = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(35_000)
    await asserted
    expect(await getDeveloperMode()).toBe(false)
  })

  it('sends latchFetch and v1Fetch to the resolved base', async () => {
    vi.stubEnv('PLASMO_PUBLIC_LATCH_STAGING_API_URL', STAGING)
    await setDeveloperMode(true)
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return jsonResponse({ ok: true })
      })
    )
    await latchFetch('/api/accounts')
    await v1Fetch('/v1/prices')
    expect(urls).toEqual([`${STAGING}/api/accounts`, `${STAGING}/v1/prices`])
  })

  it('keeps the first idle developer-mode call open through a staging wake', async () => {
    vi.useFakeTimers()
    vi.stubEnv('PLASMO_PUBLIC_LATCH_STAGING_API_URL', STAGING)
    await setDeveloperMode(true)
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('Aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
      })
    )

    const pending = latchFetch('/api/accounts')
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(settled).toBe(false)
    const failed = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(5_000)
    await failed
  })

  it('uses the normal timeout after a successful developer-mode call', async () => {
    vi.useFakeTimers()
    vi.stubEnv('PLASMO_PUBLIC_LATCH_STAGING_API_URL', STAGING)
    await setDeveloperMode(true)
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        calls += 1
        const call = calls
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('Aborted')
            e.name = 'AbortError'
            reject(e)
          })
          if (call === 1) {
            resolve(jsonResponse({ ok: true }))
          }
        })
      })
    )

    const first = latchFetch('/api/accounts')
    await vi.advanceTimersByTimeAsync(20_000)
    await first

    const second = latchFetch('/api/accounts')
    const secondFailed = expect(second).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(20_000)
    await secondFailed
  })
})
