import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { clearCachedActiveNetwork, setCachedActiveNetwork } from '../network/config'
import {
  addMultisigDraftMember,
  createMultisigDraft,
  deployMultisigDraft,
  getActiveMultisigDraft,
} from './multisigDrafts'
import {
  createMultisigProposal,
  executeMultisigProposal,
  getMultisigProposal,
  listMultisigProposals,
  refreshMultisigProposal,
} from './multisigProposals'

describe('api/multisigDrafts', () => {
  beforeEach(() => {
    clearCachedActiveNetwork()
    vi.stubEnv('PLASMO_PUBLIC_LATCH_API_URL', 'https://latch-backend.onrender.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('POST /api/multisig/drafts', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() {
        return JSON.stringify({
          draft: { id: 'draft-1', inviteToken: 'tok-abc' },
          inviteToken: 'tok-abc',
        })
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    setCachedActiveNetwork('mainnet')
    const res = await createMultisigDraft()
    expect(res.draft.id).toBe('draft-1')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://latch-backend.onrender.com/api/multisig/drafts',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ network: 'mainnet' }) })
    )
  })

  it('hides an active draft that belongs to the other network', async () => {
    setCachedActiveNetwork('mainnet')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return JSON.stringify({ draft: { id: 'draft-test', network: 'testnet' } })
        },
      }))
    )

    const res = await getActiveMultisigDraft()
    expect(res.draft).toBeNull()
  })

  it('POST /api/multisig/drafts/{id}/members uses seed for pasted G-address', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.memberType).toBe('seed')
      expect(body.gAddress).toMatch(/^G/)
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return JSON.stringify({
            draft: {
              id: 'draft-1',
              members: [
                { id: 'm1', label: 'Levi', memberType: 'delegated', gAddress: body.gAddress },
              ],
              validMemberCount: 1,
            },
          })
        },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await addMultisigDraftMember({
      draftId: 'draft-1',
      member: {
        label: 'Levi',
        memberType: 'seed',
        gAddress: 'GCEB7K5UTXGZ4HZTDXVVEDHWRUVRDAQC62AZ3T26LI42F42UWDM7L27E',
      },
    })

    expect(res.members).toHaveLength(1)
    expect(res.validMemberCount).toBe(1)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://latch-backend.onrender.com/api/multisig/drafts/draft-1/members',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('POST /api/multisig/drafts/{id}/deploy', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() {
        return JSON.stringify({
          smartAccountAddress: 'CABC123',
          alreadyDeployed: false,
        })
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await deployMultisigDraft('draft-1')
    expect(res.smartAccountAddress).toBe('CABC123')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://latch-backend.onrender.com/api/multisig/drafts/draft-1/deploy',
      expect.objectContaining({ method: 'POST' })
    )
  })
})

describe('api/multisigProposals', () => {
  beforeEach(() => {
    clearCachedActiveNetwork()
    vi.stubEnv('PLASMO_PUBLIC_LATCH_API_URL', 'https://latch-backend.onrender.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('POST /api/multisig/proposals with send fields', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body))
      expect(body.operationKind).toBe('sac_transfer')
      expect(body.tokenContractId).toBe('CAS3')
      expect(body.smartAccountAddress).toBe('CABC123')
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return JSON.stringify({ id: 'prop-1', status: 'pending' })
        },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await createMultisigProposal({
      smartAccountAddress: 'CABC123',
      operationKind: 'sac_transfer',
      recipient: 'GXYZ',
      amount: '10',
      assetId: 'native',
      tokenContractId: 'CAS3',
    })
    expect(res.id).toBe('prop-1')
  })

  it('lists and loads proposals on the active network', async () => {
    setCachedActiveNetwork('mainnet')
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      async text() {
        return JSON.stringify(
          String(url).includes('/proposals/prop-1')
            ? { id: 'prop-1', status: 'pending' }
            : { proposals: [] }
        )
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await listMultisigProposals('CABC123')
    await getMultisigProposal('prop-1')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://latch-backend.onrender.com/api/multisig/proposals?account=CABC123&network=mainnet',
      expect.objectContaining({ method: 'GET' })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://latch-backend.onrender.com/api/multisig/proposals/prop-1?network=mainnet',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('posts the active network when executing and refreshing a proposal', async () => {
    setCachedActiveNetwork('mainnet')
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ network: 'mainnet' })
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
          return JSON.stringify({ id: 'prop-1', status: 'pending' })
        },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    await executeMultisigProposal('prop-1')
    await refreshMultisigProposal('prop-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
