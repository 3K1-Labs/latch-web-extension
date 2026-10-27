// @vitest-environment jsdom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { ExternalSignLocalReview, PrepareSignResponse } from '@latch/types'

import { ExternalSignReviewScreen } from './ExternalSignReviewScreen'

afterEach(() => {
  cleanup()
})

const WALLET = 'CDBBGLSWWHWK52REY7GK5HWAQGAJJ4GP5O75LOM3F4INN6W4KT6DPBVY'
const DAPP = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

const prepared = {
  txXdr: 'x',
  authEntryXdr: 'x',
  authDigestHex: 'x',
  contextRuleId: 1,
  validUntilLedger: 1,
  network: 'testnet',
  smartAccountAddress: WALLET,
} as PrepareSignResponse

const baseReview: ExternalSignLocalReview = {
  operations: [{ type: 'invoke_contract', summary: 'Call CDLZFC...HGCYSC::swap' }],
  invokeContractIds: [DAPP],
  confirmBlocked: false,
  confirmBlockedReason: null,
}

function renderScreen(localReview: ExternalSignLocalReview) {
  render(
    <ExternalSignReviewScreen
      origin="https://dapp.example"
      prepared={prepared}
      localReview={localReview}
      onConfirm={vi.fn()}
      onReject={vi.fn()}
    />
  )
}

describe('ExternalSignReviewScreen auth tree', () => {
  it('flags a nested call to the wallet and disables Confirm', () => {
    renderScreen({
      ...baseReview,
      confirmBlocked: true,
      confirmBlockedReason: "This request tries to change your wallet's own settings.",
      code: 'self_admin_call',
      authTree: [
        {
          entryIndex: 0,
          selfCall: true,
          nodes: [
            {
              kind: 'contract_fn',
              contractId: DAPP,
              functionName: 'swap',
              depth: 0,
              selfCall: false,
            },
            {
              kind: 'contract_fn',
              contractId: WALLET,
              functionName: 'batch_add_signer',
              depth: 1,
              selfCall: true,
            },
          ],
        },
      ],
    })

    expect(screen.getByText('Authorizations')).toBeTruthy()
    expect(screen.getByText('Call CDBBGL...PBVY::batch_add_signer')).toBeTruthy()
    expect(screen.getByText('Changes your wallet')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('lists calls without a warning when nothing calls the wallet', () => {
    renderScreen({
      ...baseReview,
      authTree: [
        {
          entryIndex: 0,
          selfCall: false,
          nodes: [
            {
              kind: 'contract_fn',
              contractId: DAPP,
              functionName: 'swap',
              depth: 0,
              selfCall: false,
            },
          ],
        },
      ],
    })

    expect(screen.getByText('Authorizations')).toBeTruthy()
    expect(screen.queryByText('Changes your wallet')).toBeNull()
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('renders without an auth tree for requests stored before it existed', () => {
    renderScreen(baseReview)
    expect(screen.queryByText('Authorizations')).toBeNull()
  })
})
