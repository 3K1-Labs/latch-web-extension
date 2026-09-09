/**
 * Read-only on-chain signer reads for a deployed smart account.
 *
 * Used to prove that this install holds a key in a multisig wallet's Default
 * context rule before adding it locally. Reading grants no authority — the
 * on-chain `__check_auth` plus the threshold policy remain the only
 * authorization — this is a UX and correctness gate so we never show a wallet
 * the user cannot sign for.
 *
 * Ported from the mobile client's `fetchDefaultContextRule`, minus the factory
 * verifier lookup: we only need the raw key material to compare against local
 * signers, not which verifier contract validates it.
 */

import {
  Account,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

/**
 * Fixed source account for read-only simulations. Nothing is signed or
 * submitted, so the source only needs to be a syntactically valid address.
 */
const SIM_SOURCE_ACCOUNT = 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH'

const SIM_FEE = '100'

export type ChainSigner =
  /** Key material held by an external verifier (ed25519 seed or WebAuthn passkey). */
  | { kind: 'external'; keyDataHex: string }
  /** Authority delegated to another contract or account address. */
  | { kind: 'delegated'; address: string }

export type DefaultContextRule = {
  ruleId: number
  signers: ChainSigner[]
}

function bytesToHex(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase()
  if (value instanceof Uint8Array) {
    let out = ''
    for (const b of value) out += b.toString(16).padStart(2, '0')
    return out
  }
  return ''
}

async function simulateRead(
  server: rpc.Server,
  networkPassphrase: string,
  contractAddress: string,
  method: string,
  args: xdr.ScVal[]
): Promise<unknown> {
  const source = new Account(SIM_SOURCE_ACCOUNT, '0')
  const contract = new Contract(contractAddress)
  const tx = new TransactionBuilder(source, { fee: SIM_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} simulation failed: ${sim.error}`)
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    throw new Error(`${method}: no return value in simulation result`)
  }
  return scValToNative(sim.result.retval)
}

function isDefaultRuleType(contextType: unknown): boolean {
  if (Array.isArray(contextType)) return contextType[0] === 'Default'
  return contextType === 'Default'
}

/** Signer enum natives: `["Delegated", address]` | `["External", verifier, bytes]`. */
function decodeChainSigner(native: unknown): ChainSigner | null {
  if (!Array.isArray(native)) return null
  const variant = native[0]
  if (variant === 'Delegated') {
    const address = String(native[1] ?? '').trim()
    return address ? { kind: 'delegated', address } : null
  }
  if (variant === 'External') {
    const keyDataHex = bytesToHex(native[2])
    return keyDataHex ? { kind: 'external', keyDataHex } : null
  }
  return null
}

/**
 * Read the account's Default context rule — the rule holding every paired
 * signer — from chain.
 *
 * The Default rule id is discovered by enumerating `get_context_rule(i)` rather
 * than assumed: an admin rule installed at first pairing occupies its own id,
 * so hardcoding the default id is a latent bug.
 */
export async function fetchDefaultContextRule(args: {
  rpcUrl: string
  networkPassphrase: string
  accountAddress: string
}): Promise<DefaultContextRule> {
  const server = new rpc.Server(args.rpcUrl, { allowHttp: args.rpcUrl.startsWith('http:') })

  const count = Number(
    await simulateRead(
      server,
      args.networkPassphrase,
      args.accountAddress,
      'get_context_rules_count',
      []
    )
  )
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('no Default context rule found on account')
  }

  for (let i = 0; i < count; i++) {
    let rule: Record<string, unknown> | undefined
    try {
      rule = (await simulateRead(
        server,
        args.networkPassphrase,
        args.accountAddress,
        'get_context_rule',
        [xdr.ScVal.scvU32(i)]
      )) as Record<string, unknown>
    } catch {
      continue // id gap left by a prior rule removal
    }
    if (!rule || !isDefaultRuleType(rule.context_type)) continue

    const ruleId = typeof rule.id === 'number' ? rule.id : i
    const rawSigners = Array.isArray(rule.signers) ? rule.signers : []
    const signers = rawSigners.map(decodeChainSigner).filter((s): s is ChainSigner => s !== null)
    return { ruleId, signers }
  }

  throw new Error('no Default context rule found on account')
}
