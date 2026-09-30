import { describe, expect, it } from 'vitest'

import {
  passkeyLoginMatchesAccount,
  signerErrorMessage,
  signerErrorNeedsReverify,
} from './signerErrors'

describe('signerErrorMessage', () => {
  it('explains each signer-specific code in plain language', () => {
    expect(signerErrorMessage({ message: 'forbidden', code: 'not_a_signer' }, 'x')).toMatch(
      /Verify with your current passkey/
    )
    expect(signerErrorMessage({ message: '', code: 'signer_not_proved' }, 'x')).toBe(
      "Verify with this wallet's passkey to change its signers."
    )
    expect(signerErrorMessage({ message: '', code: 'last_signer' }, 'x')).toMatch(/only signer/)
    expect(signerErrorMessage({ message: '', code: 'signer_locked_out' }, 'x')).toMatch(
      /Add a backup passkey/
    )
    expect(signerErrorMessage({ message: '', code: 'signer_id_unknown' }, 'x')).toMatch(
      /Finish its setup/
    )
    expect(
      signerErrorMessage(
        { message: 'this account already has a backup signer', code: 'already_signer' },
        'x'
      )
    ).toBe('This wallet already has a backup passkey. Only one can be added.')
    expect(signerErrorMessage({ message: '', code: 'signer_added_index_failed' }, 'x')).toMatch(
      /added on-chain/
    )
    expect(signerErrorMessage({ message: '', code: 'validation_error' }, 'x')).toMatch(
      /has not settled/
    )
  })

  it('falls back to the API message, then the caller default', () => {
    expect(signerErrorMessage({ message: 'something specific' }, 'default')).toBe(
      'something specific'
    )
    expect(signerErrorMessage({ message: '   ' }, 'default')).toBe('default')
    expect(signerErrorMessage(undefined, 'default')).toBe('default')
  })
})

describe('signerErrorNeedsReverify', () => {
  it('offers re-verification when the session has not proved this passkey', () => {
    expect(signerErrorNeedsReverify({ message: '', code: 'not_a_signer' })).toBe(true)
    expect(signerErrorNeedsReverify({ message: '', code: 'signer_not_proved' })).toBe(true)
    expect(signerErrorNeedsReverify({ message: '', code: 'last_signer' })).toBe(false)
    expect(signerErrorNeedsReverify(undefined)).toBe(false)
  })
})

describe('passkeyLoginMatchesAccount', () => {
  it('accepts only the active wallet', () => {
    expect(passkeyLoginMatchesAccount('CADDR', 'CADDR')).toBe(true)
    expect(passkeyLoginMatchesAccount(' CADDR ', 'CADDR')).toBe(true)
    expect(passkeyLoginMatchesAccount('COTHER', 'CADDR')).toBe(false)
    expect(passkeyLoginMatchesAccount(undefined, 'CADDR')).toBe(false)
  })
})
