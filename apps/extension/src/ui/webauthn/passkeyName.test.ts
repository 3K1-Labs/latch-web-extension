import type { StoredAccount } from '@latch/types'
import { describe, expect, it, vi } from 'vitest'

import { buildPasskeyName, buildPasskeyRegistrationName, reservePasskeyName } from './passkeyName'

function account(mode: StoredAccount['mode'], id: string): StoredAccount {
  return { id, mode, smartAccountAddress: 'SADDR', createdAt: 0 }
}

/** Stand in for the background so reservePasskeyName can talk to a counter. */
function stubBackground(handler: (message: any) => unknown): { messages: any[] } {
  const messages: any[] = []
  chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: any) => {
    messages.push(message)
    sendResponse(handler(message))
  })
  return { messages }
}

describe('webauthn/passkeyName', () => {
  it('names an unlabelled passkey "Latch Wallet N"', () => {
    expect(buildPasskeyName(1)).toBe('Latch Wallet 1')
    expect(buildPasskeyName(12)).toBe('Latch Wallet 12')
  })

  it('folds a user-chosen account name into the label', () => {
    expect(buildPasskeyName(2, 'Savings')).toBe('Savings (Latch 2)')
  })

  it('treats a blank account name as absent', () => {
    expect(buildPasskeyName(3, '   ')).toBe('Latch Wallet 3')
    expect(buildPasskeyName(3, '')).toBe('Latch Wallet 3')
  })

  it('trims the account name', () => {
    expect(buildPasskeyName(4, '  Trading  ')).toBe('Trading (Latch 4)')
  })

  it('appends a flow context when given one', () => {
    expect(buildPasskeyRegistrationName(5)).toBe('Latch Wallet 5')
    expect(buildPasskeyRegistrationName(5, undefined, 'multisig join')).toBe(
      'Latch Wallet 5 · multisig join'
    )
    expect(buildPasskeyRegistrationName(6, 'Team vault', 'multisig')).toBe(
      'Team vault (Latch 6) · multisig'
    )
    expect(buildPasskeyRegistrationName(7, 'Team vault', '  ')).toBe('Team vault (Latch 7)')
  })

  it('names from the background counter and commits only when asked', async () => {
    const bg = stubBackground((message) =>
      message.type === 'PASSKEY_NEXT_SEQ' ? { ok: true, data: { seq: 7 } } : { ok: true }
    )

    const reserved = await reservePasskeyName({ accountLabel: 'Savings' })
    expect(reserved.seq).toBe(7)
    expect(reserved.displayName).toBe('Savings (Latch 7)')
    expect(bg.messages.map((m) => m.type)).toEqual(['PASSKEY_NEXT_SEQ'])

    await reserved.commit()
    expect(bg.messages[1]).toEqual({ type: 'PASSKEY_CONFIRM_SEQ', payload: { seq: 7 } })
  })

  it('falls back to the local passkey count when the counter is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubBackground(() => ({ ok: false, error: { message: 'boom' } }))

    const reserved = await reservePasskeyName({
      fallbackAccounts: [
        account('passkey', '1'),
        account('mnemonic', '2'),
        account('passkey', '3'),
      ],
    })

    expect(reserved.seq).toBe(3)
    expect(reserved.displayName).toBe('Latch Wallet 3')
    expect(warn).toHaveBeenCalled()
  })

  it('never throws over a cosmetic label when the background is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // No onMessage listener at all: chrome.runtime.sendMessage rejects.
    const reserved = await reservePasskeyName({ accountLabel: 'Savings' })
    expect(reserved.displayName).toBe('Savings (Latch 1)')
    await expect(reserved.commit()).resolves.toBeUndefined()
  })
})
