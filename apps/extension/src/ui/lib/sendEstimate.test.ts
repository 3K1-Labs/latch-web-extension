import { describe, expect, it, vi } from 'vitest'

import type { BuildSendTxResponse } from '@latch/types'

import { SEND_SETUP_FAILED_CODE } from '../types/send'
import { estimateSendWithSetup } from './sendEstimate'

const BUILD = { txXdr: 'x' } as unknown as BuildSendTxResponse
const missingRules = {
  ok: false as const,
  error: { message: 'no rule', code: 'NO_CONTEXT_RULE', status: 409 },
}

describe('estimateSendWithSetup', () => {
  it('sets up once and shows the rebuilt fee when rules were missing', async () => {
    const build = vi
      .fn()
      .mockResolvedValueOnce(missingRules)
      .mockResolvedValueOnce({ ok: true, data: BUILD })
    const runSetup = vi.fn().mockResolvedValue({ ok: true, result: 'configured' })

    expect(await estimateSendWithSetup({ build, runSetup })).toEqual({ ok: true, data: BUILD })
    expect(runSetup).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('tells the screen when setup starts, and only then', async () => {
    const onSettingUp = vi.fn()
    const runSetup = vi.fn().mockResolvedValue({ ok: true, result: 'configured' })
    await estimateSendWithSetup({
      build: async () => ({ ok: true, data: BUILD }),
      runSetup,
      onSettingUp,
    })
    expect(onSettingUp).not.toHaveBeenCalled()

    const build = vi
      .fn()
      .mockResolvedValueOnce(missingRules)
      .mockResolvedValueOnce({ ok: true, data: BUILD })
    await estimateSendWithSetup({ build, runSetup, onSettingUp })
    expect(onSettingUp).toHaveBeenCalledTimes(1)
  })

  it('returns the original error without a second build when already configured', async () => {
    const build = vi.fn().mockResolvedValue(missingRules)
    const runSetup = vi.fn().mockResolvedValue({ ok: true, result: 'already_configured' })

    expect(await estimateSendWithSetup({ build, runSetup })).toBe(missingRules)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('reports a failed setup with the setup-failed code', async () => {
    const build = vi.fn().mockResolvedValue(missingRules)
    const runSetup = vi.fn().mockResolvedValue({ ok: false, message: 'setup broke' })

    expect(await estimateSendWithSetup({ build, runSetup })).toEqual({
      ok: false,
      error: { message: 'setup broke', code: SEND_SETUP_FAILED_CODE },
    })
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('does not set up for errors that are not about missing rules', async () => {
    const other = { ok: false as const, error: { message: 'down', code: 'sponsorship_retry' } }
    const build = vi.fn().mockResolvedValue(other)
    const runSetup = vi.fn()

    expect(await estimateSendWithSetup({ build, runSetup })).toBe(other)
    expect(runSetup).not.toHaveBeenCalled()
  })

  it('does not set up when the first build succeeds', async () => {
    const ok = { ok: true as const, data: BUILD }
    const runSetup = vi.fn()
    expect(await estimateSendWithSetup({ build: async () => ok, runSetup })).toBe(ok)
    expect(runSetup).not.toHaveBeenCalled()
  })
})
