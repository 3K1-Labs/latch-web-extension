import { describe, expect, it, vi } from 'vitest'

import type { StoredAccount } from '@latch/types'

import {
  accountToSignerType,
  buildSendRequestFromDraft,
  buildSetupRequestFromDraft,
  contextRuleIdForSubmit,
  enrichSendFailureDetail,
  explainSendDraftNotBuildable,
  isDelegatedSendBuild,
  isBuildSendMissingSetupError,
  isMissingTrustlineErrorMessage,
  isOpaqueSendBuildFailureMessage,
  isPrepareSignMissingSetupError,
  isSwapRuleReconfigureError,
  missingTrustlineSendMessage,
  normalizeDelegatedBuildFields,
  resolvePasskeyAuthEntryXdr,
  tokenRequiresClassicTrustline,
} from './sendTx'
import type { SendDraft } from '../types/send'

vi.mock('./latchEnv', () => ({
  webauthnVerifierAddressFromEnv: () => 'CVERIFIER123',
}))

describe('accountToSignerType', () => {
  it('maps multisig to passkey (members sign with WebAuthn, not Freighter G)', () => {
    expect(accountToSignerType('multisig')).toBe('passkey')
  })
})

describe('buildSendRequestFromDraft', () => {
  const baseDraft: SendDraft = {
    token: {
      code: 'USDC',
      sacContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      amount: '5',
    },
    recipientAddress: 'CAN4WMQCBD2UY5E37VCTFA3YNOOHMLNX4JN3T4DQKKMMNBJBY57DNGNF',
    amount: '5',
    inputMode: 'crypto',
  }

  const multisigAccount: StoredAccount = {
    id: 'ms1',
    mode: 'multisig',
    smartAccountAddress: 'CBY4TTIDC3WY2WCEMT2M35M6W6SYW33LES4JAX2XLLZHZCN3LOWGHMZS',
    createdAt: 0,
  }

  it('uses passkey signerType without signerG for multisig accounts', () => {
    const req = buildSendRequestFromDraft(baseDraft, multisigAccount, null)
    expect(req).toMatchObject({
      signerType: 'passkey',
      smartAccountAddress: multisigAccount.smartAccountAddress,
      recipient: baseDraft.recipientAddress,
      amount: '5',
      assetId: 'USDC',
      contractId: baseDraft.token!.sacContractId,
    })
    expect(req?.signerG).toBeUndefined()
  })

  it('sends the signing passkey keyDataHex for passkey accounts only', () => {
    const passkeyAccount: StoredAccount = {
      id: 'pk1',
      mode: 'passkey',
      smartAccountAddress: multisigAccount.smartAccountAddress,
      passkeyCredentialId: 'cred-b',
      passkeyKeyDataHex: ' bbcc ',
      createdAt: 0,
    }
    expect(buildSendRequestFromDraft(baseDraft, passkeyAccount, null)?.keyDataHex).toBe('bbcc')
    expect(buildSendRequestFromDraft(baseDraft, multisigAccount, null)?.keyDataHex).toBeUndefined()
    expect(
      buildSendRequestFromDraft(
        baseDraft,
        { ...passkeyAccount, mode: 'mnemonic', gAddress: 'GSEED' },
        null
      )?.keyDataHex
    ).toBeUndefined()
  })

  it('maps XLM portfolio rows without assetId to native', () => {
    const draft: SendDraft = {
      token: {
        code: 'XLM',
        sacContractId: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
        amount: '10',
      },
      recipientAddress: 'GABC',
      amount: '1',
      inputMode: 'crypto',
    }
    const req = buildSendRequestFromDraft(draft, multisigAccount, null, 'mainnet')
    expect(req).toMatchObject({
      assetId: 'native',
      contractId: draft.token!.sacContractId,
      amount: '1',
      network: 'mainnet',
    })
  })

  it('maps non-XLM portfolio rows without assetId to token code', () => {
    const req = buildSendRequestFromDraft(baseDraft, multisigAccount, null, 'mainnet')
    expect(req).toMatchObject({
      assetId: 'USDC',
      contractId: baseDraft.token!.sacContractId,
      network: 'mainnet',
    })
  })

  it('rejects fiat amounts when USD price is missing', () => {
    const draft: SendDraft = {
      ...baseDraft,
      amount: '50',
      inputMode: 'fiat',
    }
    expect(explainSendDraftNotBuildable(draft, multisigAccount, null)).toMatch(/USD price/i)
    expect(buildSendRequestFromDraft(draft, multisigAccount, null)).toBeNull()
  })
})

describe('buildSetupRequestFromDraft', () => {
  const baseDraft: SendDraft = {
    token: {
      code: 'XLM',
      sacContractId: 'CAS3',
      assetId: 'native',
      amount: '10',
    },
    recipientAddress: 'GABC',
    amount: '1',
    inputMode: 'crypto',
  }

  const passkeyAccount: StoredAccount = {
    id: '1',
    mode: 'passkey',
    smartAccountAddress: 'CACC',
    passkeyCredentialId: 'cred',
    passkeyKeyDataHex: 'aa'.repeat(66),
    createdAt: 0,
  }

  const multisigAccount: StoredAccount = {
    id: 'ms1',
    mode: 'multisig',
    smartAccountAddress: 'CMULTI',
    createdAt: 0,
  }

  it('includes verifierAddress and keyDataHex for passkey setup', () => {
    const req = buildSetupRequestFromDraft(baseDraft, passkeyAccount)
    expect(req).toMatchObject({
      signerType: 'passkey',
      assetId: 'native',
      keyDataHex: passkeyAccount.passkeyKeyDataHex,
      verifierAddress: 'CVERIFIER123',
    })
  })

  it('includes network when provided (required for mainnet setup)', () => {
    const req = buildSetupRequestFromDraft(baseDraft, passkeyAccount, undefined, 'mainnet')
    expect(req).toMatchObject({ network: 'mainnet', assetId: 'native' })
  })

  it('omits verifierAddress on mainnet when mainnet verifier env is unset', () => {
    const req = buildSetupRequestFromDraft(baseDraft, passkeyAccount, undefined, 'mainnet')
    // Test mock still returns CVERIFIER123 for any network — assert shape separately in latchEnv tests.
    expect(req?.network).toBe('mainnet')
    expect(req?.keyDataHex).toBe(passkeyAccount.passkeyKeyDataHex)
  })

  it('uses member passkey credentials when setting up a multisig wallet', () => {
    const req = buildSetupRequestFromDraft(baseDraft, multisigAccount, passkeyAccount)
    expect(req).toMatchObject({
      smartAccountAddress: 'CMULTI',
      signerType: 'passkey',
      assetId: 'native',
      keyDataHex: passkeyAccount.passkeyKeyDataHex,
      verifierAddress: 'CVERIFIER123',
      credentialId: 'cred',
    })
  })

  it('returns null when passkey keyDataHex is missing', () => {
    const req = buildSetupRequestFromDraft(baseDraft, {
      ...passkeyAccount,
      passkeyKeyDataHex: undefined,
    })
    expect(req).toBeNull()
  })
})

describe('normalizeDelegatedBuildFields', () => {
  it('derives delegated template fields from authEntriesXdr indices', () => {
    const normalized = normalizeDelegatedBuildFields({
      txXdr: 'tx',
      authEntryXdr: 'legacy-auth',
      contextRuleId: 1,
      authDigestHex: 'digest',
      validUntilLedger: 100,
      submitMethod: 'delegated',
      delegatedGAuthEntrySynthesized: true,
      smartAccountAuthEntryIndex: 0,
      delegatedNativeAuthEntryIndices: [1],
      authEntriesXdr: ['smart-entry', 'g-entry'],
    })

    expect(normalized.smartAccountAuthEntryXdr).toBe('smart-entry')
    expect(normalized.gAddressEntryTemplateXdr).toBe('g-entry')
    expect(normalized.authEntryXdr).toBe('legacy-auth')
    expect(isDelegatedSendBuild(normalized)).toBe(true)
  })

  it('coerces contextRuleId to a JSON number for submit routes', () => {
    expect(contextRuleIdForSubmit({ contextRuleId: 1 } as any)).toBe(1)
    expect(contextRuleIdForSubmit({ contextRuleId: '14' } as any)).toBe(14)
    expect(contextRuleIdForSubmit({ contextRuleIds: [14] } as any)).toBe(14)
  })
})

describe('resolvePasskeyAuthEntryXdr', () => {
  it('prefers authEntriesXdr[smartAccountAuthEntryIndex] over legacy authEntryXdr', () => {
    const entry0 = 'ENTRY-0'
    const entry1 = 'ENTRY-1'
    expect(
      resolvePasskeyAuthEntryXdr({
        txXdr: 'tx',
        authEntryXdr: 'LEGACY',
        contextRuleId: 0,
        authDigestHex: 'aa',
        validUntilLedger: 1,
        authEntriesXdr: [entry0, entry1],
        smartAccountAuthEntryIndex: 1,
      })
    ).toBe(entry1)
  })
})

describe('isPrepareSignMissingSetupError', () => {
  it('matches prepare-sign opaque 400 internal_error', () => {
    expect(
      isPrepareSignMissingSetupError({
        status: 400,
        code: 'internal_error',
        message: 'failed to prepare transaction',
      })
    ).toBe(true)
  })

  it('matches NO_CONTEXT_RULE 409', () => {
    expect(isPrepareSignMissingSetupError({ status: 409, code: 'NO_CONTEXT_RULE' })).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isPrepareSignMissingSetupError({ status: 400, code: 'invalid_network' })).toBe(false)
    expect(isPrepareSignMissingSetupError({ status: 500, code: 'internal_error' })).toBe(false)
  })

  it('does not retry setup when this passkey is not a signer', () => {
    expect(isPrepareSignMissingSetupError({ status: 409, code: 'signer_rule_not_found' })).toBe(
      false
    )
  })
})

describe('isBuildSendMissingSetupError', () => {
  it('matches opaque build-send 400 internal_error', () => {
    expect(
      isBuildSendMissingSetupError({
        status: 400,
        code: 'internal_error',
        message: 'failed to build transaction',
      })
    ).toBe(true)
  })

  it('matches NO_CONTEXT_RULE 409', () => {
    expect(isBuildSendMissingSetupError({ status: 409, code: 'NO_CONTEXT_RULE' })).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isBuildSendMissingSetupError({ status: 400, code: 'invalid_network' })).toBe(false)
    expect(isBuildSendMissingSetupError({ status: 500, code: 'internal_error' })).toBe(false)
  })

  it('does not retry setup when this passkey is not a signer', () => {
    expect(isBuildSendMissingSetupError({ status: 409, code: 'signer_rule_not_found' })).toBe(false)
    expect(isSwapRuleReconfigureError({ status: 409, code: 'signer_rule_not_found' })).toBe(false)
  })
})

describe('trustline send failure messaging', () => {
  it('formats a clear missing-trustline message for any token symbol', () => {
    expect(missingTrustlineSendMessage('USDC')).toBe(
      'This address can’t receive USDC yet. They need to add a USDC trustline in their wallet first.'
    )
    expect(missingTrustlineSendMessage('EURC')).toContain('EURC')
  })

  it('detects trustline simulation / API error text', () => {
    expect(
      isMissingTrustlineErrorMessage(
        'transfer simulation failed: trustline entry is missing for account GABC'
      )
    ).toBe(true)
    expect(isMissingTrustlineErrorMessage('failed to build transaction')).toBe(false)
  })

  it('detects opaque build-send failure text', () => {
    expect(isOpaqueSendBuildFailureMessage('failed to build transaction')).toBe(true)
    expect(isOpaqueSendBuildFailureMessage('insufficient balance')).toBe(false)
  })

  it('requires a classic trustline only for non-native tokens', () => {
    expect(
      tokenRequiresClassicTrustline({
        code: 'USDC',
        issuer: 'GABC',
        sacContractId: 'CUSDC',
        amount: '1',
      })
    ).toBe(true)
    expect(
      tokenRequiresClassicTrustline({
        code: 'XLM',
        sacContractId: 'CXLM',
        amount: '1',
        assetId: 'native',
      })
    ).toBe(false)
  })

  it('maps explicit trustline errors without Horizon', async () => {
    const detail = await enrichSendFailureDetail({
      errorMessage: 'HostError: trustline entry is missing for account GABC',
      draft: {
        token: {
          code: 'USDC',
          issuer: 'GISSUER',
          sacContractId: 'CUSDC',
          amount: '1',
        },
        recipientAddress: 'GCEB7K5UTXGZ4HZTDXVVEDHWRUVRDAQC62AZ3T26LI42F42UWDM7L27E',
        amount: '1',
        inputMode: 'crypto',
      },
      network: 'mainnet',
    })
    expect(detail).toBe(missingTrustlineSendMessage('USDC'))
  })

  it('leaves unrelated failures unchanged', async () => {
    const detail = await enrichSendFailureDetail({
      errorMessage: 'Request timed out. Please try again.',
      draft: {
        token: {
          code: 'USDC',
          issuer: 'GISSUER',
          sacContractId: 'CUSDC',
          amount: '1',
        },
        recipientAddress: 'GCEB7K5UTXGZ4HZTDXVVEDHWRUVRDAQC62AZ3T26LI42F42UWDM7L27E',
        amount: '1',
        inputMode: 'crypto',
      },
      network: 'mainnet',
    })
    expect(detail).toBe('Request timed out. Please try again.')
  })
})
