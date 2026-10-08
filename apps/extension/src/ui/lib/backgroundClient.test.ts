import { afterEach, describe, expect, it, vi } from 'vitest'

import { friendlyError, logLatchError, sendToBackground } from './backgroundClient'

describe('friendlyError', () => {
  it('returns empty string for cancelled so superseded fetches stay quiet', () => {
    expect(friendlyError({ code: 'cancelled', message: 'aborted' })).toBe('')
  })

  it('maps timeout to user-safe copy', () => {
    expect(friendlyError({ code: 'timeout', message: 'timed out' })).toBe(
      'Request timed out. Please try again.'
    )
  })

  it('falls back when message is blank', () => {
    expect(friendlyError({ message: '' })).toBe('Something went wrong. Please try again.')
    expect(friendlyError({ message: '   ' })).toBe('Something went wrong. Please try again.')
  })

  it('returns Unknown error when error is missing', () => {
    expect(friendlyError(undefined)).toBe('Unknown error')
  })
})

describe('sendToBackground', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rejects when the background never answers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: () => new Promise(() => {}) },
    })

    const pending = sendToBackground({ type: 'GET_ACCOUNTS', payload: undefined }, 1_000)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('rejects when sendMessage returns no response', async () => {
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: async () => undefined },
    })

    await expect(
      sendToBackground({ type: 'GET_ACCOUNTS', payload: undefined }, 1_000)
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('logLatchError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs with a latch scope prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logLatchError('send', new Error('boom'))
    expect(spy).toHaveBeenCalledWith('[latch:send]', 'boom')
  })
})
