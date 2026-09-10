/**
 * Gated diagnostic for issue #61: compare recording vs enforcing resource
 * footprints on a real submit path. Never blocks or fails the real submit.
 *
 * Enable with PLASMO_PUBLIC_DEBUG_ENFORCING_SIM=1 then watch the service worker
 * console for `[latch][issue-61] underestimated=…`.
 */

import {
  applyDelegatedGSignature,
  buildDelegatedAuthPayload,
  buildWebAuthnAuthPayload,
  compareResourceSummaries,
  contextRuleIdsForEntry,
  createRpcServer,
  formatResourceCompareLog,
  replaceInvokeHostAuth,
  setAddressAuthSignature,
  summarizeSimulationResources,
  summarizeTransactionResources,
} from '@latch/stellar'
import { rpc, Transaction, xdr } from '@stellar/stellar-sdk'
import type { Network, SubmitDelegatedTxRequest, SubmitWebauthnTxRequest } from '@latch/types'

import { getActiveNetwork, networkPassphraseFor, sorobanRpcUrlFor } from '../network/config'

function debugEnforcingSimEnabled(): boolean {
  const raw = process.env.PLASMO_PUBLIC_DEBUG_ENFORCING_SIM
  return raw === '1' || raw === 'true'
}

function webauthnVerifierAddress(network: Network): string | undefined {
  if (network === 'mainnet') {
    const mainnet = process.env.PLASMO_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS_MAINNET
    if (typeof mainnet === 'string' && mainnet.trim() !== '') return mainnet.trim()
    return undefined
  }
  const raw = process.env.PLASMO_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function decodeAuthEntries(b64List: string[]): xdr.SorobanAuthorizationEntry[] {
  return b64List.map((b64) => xdr.SorobanAuthorizationEntry.fromXDR(b64, 'base64'))
}

function resolveAuthEntries(
  authEntriesXdr: string[] | undefined,
  fallback: string[]
): xdr.SorobanAuthorizationEntry[] {
  const list = authEntriesXdr?.length ? authEntriesXdr : fallback
  if (!list.length) throw new Error('No auth entries for enforcing-sim probe')
  return decodeAuthEntries(list)
}

async function probeEnforcingSim(args: {
  txXdr: string
  signedEntries: xdr.SorobanAuthorizationEntry[]
}): Promise<void> {
  const network = await getActiveNetwork()
  const passphrase = networkPassphraseFor(network)
  const server = createRpcServer(sorobanRpcUrlFor(network))

  const recordingTx = new Transaction(args.txXdr, passphrase)
  const recording = summarizeTransactionResources(recordingTx)
  if (!recording) {
    console.warn('[latch][issue-61] recording tx has no Soroban resource data; skipping probe')
    return
  }

  const withAuth = replaceInvokeHostAuth(recordingTx, args.signedEntries, passphrase)
  const sim = await server.simulateTransaction(withAuth)
  if (rpc.Api.isSimulationError(sim)) {
    console.warn(
      '[latch][issue-61] enforcing simulation error (probe only):',
      typeof sim.error === 'string' ? sim.error : JSON.stringify(sim.error)
    )
    return
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    console.warn('[latch][issue-61] unexpected enforcing simulation response; skipping')
    return
  }

  const enforcing = summarizeSimulationResources(sim)
  const compared = compareResourceSummaries(recording, enforcing)
  console.log(formatResourceCompareLog(compared))
}

/**
 * Fire-and-forget probe for WebAuthn submit. Errors are logged; never thrown.
 */
export function maybeProbeWebauthnEnforcingSim(req: SubmitWebauthnTxRequest): void {
  if (!debugEnforcingSimEnabled()) return
  void (async () => {
    try {
      const network = await getActiveNetwork()
      const verifier = webauthnVerifierAddress(network)
      if (!verifier) {
        console.warn(
          '[latch][issue-61] PLASMO_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS unset; skipping probe'
        )
        return
      }

      const entries = resolveAuthEntries(req.authEntriesXdr, [req.authEntryXdr])
      const idx = req.smartAccountAuthEntryIndex ?? 0
      if (idx < 0 || idx >= entries.length) {
        throw new Error(`smartAccountAuthEntryIndex ${idx} out of range`)
      }

      const ruleId = req.contextRuleId
      if (typeof ruleId !== 'number' || !Number.isFinite(ruleId)) {
        throw new Error('contextRuleId required for enforcing-sim probe')
      }
      const ruleIds = contextRuleIdsForEntry(entries[idx]!, ruleId)
      const sigData = Buffer.from(req.sigDataXdr, 'hex')
      const payload = buildWebAuthnAuthPayload(verifier, req.keyDataHex, sigData, ruleIds)
      entries[idx] = setAddressAuthSignature(entries[idx]!, payload)

      await probeEnforcingSim({ txXdr: req.txXdr, signedEntries: entries })
    } catch (err) {
      console.warn(
        '[latch][issue-61] webauthn probe failed (non-fatal):',
        err instanceof Error ? err.message : String(err)
      )
    }
  })()
}

/**
 * Fire-and-forget probe for delegated (mnemonic) submit. Errors are logged; never thrown.
 */
export function maybeProbeDelegatedEnforcingSim(req: SubmitDelegatedTxRequest): void {
  if (!debugEnforcingSimEnabled()) return
  void (async () => {
    try {
      const entries = resolveAuthEntries(req.authEntriesXdr, [
        req.smartAccountAuthEntryXdr,
        req.gAddressEntryTemplateXdr,
      ])
      const idx = req.smartAccountAuthEntryIndex ?? 0
      if (idx < 0 || idx >= entries.length) {
        throw new Error(`smartAccountAuthEntryIndex ${idx} out of range`)
      }

      const ruleId = req.contextRuleId
      if (typeof ruleId !== 'number' || !Number.isFinite(ruleId)) {
        throw new Error('contextRuleId required for enforcing-sim probe')
      }
      const ruleIds = contextRuleIdsForEntry(entries[idx]!, ruleId)
      const payload = buildDelegatedAuthPayload(req.signerAddress, ruleIds)
      entries[idx] = setAddressAuthSignature(entries[idx]!, payload)

      const template = xdr.SorobanAuthorizationEntry.fromXDR(req.gAddressEntryTemplateXdr, 'base64')
      const rawSig = Buffer.from(req.signedAuthEntryBase64, 'base64')
      let signedDelegated: xdr.SorobanAuthorizationEntry
      if (rawSig.length === 64) {
        signedDelegated = applyDelegatedGSignature(template, rawSig, req.signerAddress)
      } else {
        // Full signed entry XDR (rare; normalizeDelegatedSignatureBase64 usually strips to 64).
        signedDelegated = xdr.SorobanAuthorizationEntry.fromXDR(req.signedAuthEntryBase64, 'base64')
      }

      // Match template in the entry list by XDR equality of the unsigned template.
      const templateXdr = req.gAddressEntryTemplateXdr
      let delegatedIdx = -1
      for (let i = 0; i < entries.length; i++) {
        if (i === idx) continue
        if (entries[i]!.toXDR('base64') === templateXdr) {
          delegatedIdx = i
          break
        }
      }
      if (delegatedIdx < 0) {
        // Fall back: second entry or append.
        delegatedIdx = entries.length > 1 && idx !== 1 ? 1 : entries.length
        if (delegatedIdx >= entries.length) entries.push(signedDelegated)
        else entries[delegatedIdx] = signedDelegated
      } else {
        entries[delegatedIdx] = signedDelegated
      }

      await probeEnforcingSim({ txXdr: req.txXdr, signedEntries: entries })
    } catch (err) {
      console.warn(
        '[latch][issue-61] delegated probe failed (non-fatal):',
        err instanceof Error ? err.message : String(err)
      )
    }
  })()
}
