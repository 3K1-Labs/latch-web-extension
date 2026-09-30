import { describe, expect, it } from 'vitest'

import { parseApiError } from './errors'

describe('api/errors', () => {
  it('parses webapp flat error shape', () => {
    expect(parseApiError(409, { error: 'Context rule required', code: 'NO_CONTEXT_RULE' })).toEqual(
      {
        message: 'Context rule required',
        code: 'NO_CONTEXT_RULE',
      }
    )
  })

  it('parses v1 nested error shape', () => {
    expect(
      parseApiError(400, {
        error: { code: 'INVALID_TOKENS', message: 'tokens query param required' },
      })
    ).toEqual({
      message: 'tokens query param required',
      code: 'INVALID_TOKENS',
    })
  })

  it('replaces signer_rule_not_found with user copy and keeps the code', () => {
    const copy = "This passkey isn't a signer on this wallet. Sign in with a passkey that is."
    expect(
      parseApiError(409, {
        error: 'this passkey is not an authorized signer of this smart account',
        code: 'signer_rule_not_found',
        message: 'this passkey is not an authorized signer of this smart account',
      })
    ).toEqual({ message: copy, code: 'signer_rule_not_found' })
    expect(
      parseApiError(409, {
        error: {
          code: 'signer_rule_not_found',
          message: 'this passkey is not an authorized signer of this smart account',
        },
      })
    ).toEqual({ message: copy, code: 'signer_rule_not_found' })
  })

  it('falls back when body is empty', () => {
    expect(parseApiError(500, undefined)).toEqual({ message: 'Request failed: 500' })
  })
})
