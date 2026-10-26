import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChromeMock } from '../test/chromeMock'
import {
  clearPendingWalletOutcome,
  consumePendingWalletOutcomeIf,
  finalizePendingWalletOutcome,
  PENDING_WALLET_OUTCOME_KEY,
  readPendingWalletOutcome,
  writePendingWalletOutcome,
} from './walletOutcome'

describe('walletOutcome', () => {
  beforeEach(() => {
    const mock = createChromeMock()
    globalThis.chrome = mock as unknown as typeof chrome
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes and reads pending outcome', async () => {
    await writePendingWalletOutcome({
      kind: 'swap',
      status: 'in_progress',
      payload: { draft: { payAmount: '1' } },
    })
    const pending = await readPendingWalletOutcome()
    expect(pending?.kind).toBe('swap')
    expect(pending?.status).toBe('in_progress')
    expect(pending?.payload).toEqual({ draft: { payAmount: '1' } })
  })

  it('finalize preserves payload and consume clears terminal outcomes', async () => {
    await writePendingWalletOutcome({
      kind: 'send',
      status: 'in_progress',
      payload: { draft: { amount: '2' } },
    })
    await finalizePendingWalletOutcome({
      kind: 'send',
      status: 'success',
    })
    const consumed = await consumePendingWalletOutcomeIf('send')
    expect(consumed?.status).toBe('success')
    expect(consumed?.payload).toEqual({ draft: { amount: '2' } })
    const bag = await chrome.storage.session.get(PENDING_WALLET_OUTCOME_KEY)
    expect(bag[PENDING_WALLET_OUTCOME_KEY]).toBeUndefined()
  })

  it('review_again replaces in_progress, keeps the draft payload, and is consumed once', async () => {
    await writePendingWalletOutcome({
      kind: 'send',
      status: 'in_progress',
      payload: { draft: { amount: '2' } },
    })
    await finalizePendingWalletOutcome({
      kind: 'send',
      status: 'review_again',
      error: 'The network fee changed.',
    })
    const consumed = await consumePendingWalletOutcomeIf('send')
    expect(consumed?.status).toBe('review_again')
    expect(consumed?.error).toBe('The network fee changed.')
    expect(consumed?.payload).toEqual({ draft: { amount: '2' } })
    expect(await readPendingWalletOutcome()).toBeNull()
  })

  it('consume ignores other kinds', async () => {
    await writePendingWalletOutcome({
      kind: 'swap',
      status: 'failure',
      error: 'nope',
    })
    expect(await consumePendingWalletOutcomeIf('send')).toBeNull()
    expect((await readPendingWalletOutcome())?.kind).toBe('swap')
    await clearPendingWalletOutcome()
  })
})
