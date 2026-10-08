#!/usr/bin/env node
// rpc-probe.mjs — compare Stellar RPC endpoints on the things Latch depends on.
// Zero dependencies (Node 18+). Read-only: never signs or submits anything.
//
// Usage:
//   node scripts/rpc-probe.mjs <rpcUrl> [<rpcUrl> ...]
//   node scripts/rpc-probe.mjs https://svc.blockdaemon.com/stellar/mainnet/native/soroban-rpc \
//     --header "X-API-Key: $BLOCKDAEMON_KEY"
//
// --header applies to every URL after it. --burst N sets the rate-limit burst (default 25).

import { createHash, randomBytes } from 'node:crypto'

// ---------- strkey + XDR helpers (just enough for the probes) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32decode(s) {
  let bits = 0, val = 0
  const out = []
  for (const c of s) {
    val = (val << 5) | B32.indexOf(c)
    bits += 5
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}
function b32encode(buf) {
  let bits = 0, val = 0, out = ''
  for (const b of buf) {
    val = (val << 8) | b
    bits += 8
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31]
  return out
}
function crc16(buf) {
  let crc = 0
  for (const b of buf) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}
const strkeyRaw = (s) => b32decode(s).subarray(1, 33)
function contractStrkey(hash32) {
  const payload = Buffer.concat([Buffer.from([2 << 3]), hash32])
  const c = crc16(payload)
  return b32encode(Buffer.concat([payload, Buffer.from([c & 0xff, c >> 8])]))
}
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
const sha256 = (b) => createHash('sha256').update(b).digest()

/** Native XLM Stellar Asset Contract id for a network passphrase. */
function nativeSacId(passphrase) {
  const preimage = Buffer.concat([i32(8), sha256(Buffer.from(passphrase)), i32(1), i32(0)])
  return contractStrkey(sha256(preimage))
}
/** LedgerKey::Account for a G-address. */
const accountKeyXdr = (g) => Buffer.concat([i32(0), i32(0), strkeyRaw(g)]).toString('base64')
/** LedgerKey::ContractData(instance) for a C-address. */
const contractInstanceKeyXdr = (c) =>
  Buffer.concat([i32(6), i32(1), strkeyRaw(c), i32(20), i32(1)]).toString('base64')
const TRANSFER_TOPIC = Buffer.concat([i32(15), i32(8), Buffer.from('transfer')]).toString('base64')
// A random C-address that never receives anything: forces getEvents to scan the whole range,
// which is the worst case for Latch's "transfers to/from my wallet" query.
const NEVER_MATCH = Buffer.concat([i32(18), i32(1), randomBytes(32)]).toString('base64')

// ---------- JSON-RPC ----------
let reqId = 0
async function rpc(url, headers, method, params, timeoutMs = 30_000) {
  const t0 = performance.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++reqId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const ms = Math.round(performance.now() - t0)
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { return { ms, status: res.status, error: `non-JSON: ${text.slice(0, 80)}` } }
    if (body.error) return { ms, status: res.status, error: body.error.message ?? JSON.stringify(body.error) }
    if (!res.ok) return { ms, status: res.status, error: `HTTP ${res.status}` }
    return { ms, status: res.status, result: body.result }
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), status: 0, error: e.name === 'TimeoutError' ? 'timeout' : e.message }
  }
}

const LEDGERS_PER_DAY = 17_280 // ~5s ledgers
const days = (n) => (n / LEDGERS_PER_DAY).toFixed(1) + 'd'
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]
const mark = (ok) => (ok ? 'PASS' : 'FAIL')

async function probe(url, headers, burst) {
  const call = (m, p, t) => rpc(url, headers, m, p, t)
  const out = { url }
  const lines = []
  const row = (name, verdict, detail) => lines.push(`  ${verdict.padEnd(4)}  ${name.padEnd(28)} ${detail}`)

  const [health, network, version, latest] = await Promise.all([
    call('getHealth'), call('getNetwork'), call('getVersionInfo'), call('getLatestLedger'),
  ])
  if (network.error) {
    console.log(`\n${url}\n  FAIL  unreachable: ${network.error}`)
    return out
  }
  const passphrase = network.result.passphrase
  const net = passphrase.startsWith('Public') ? 'mainnet' : passphrase.startsWith('Test') ? 'testnet' : 'other'
  out.net = net
  out.latest = latest.result?.sequence

  row('network', 'INFO', `${net} | protocol ${network.result.protocolVersion}`)
  row('version', 'INFO', version.result ? `${version.result.version ?? '?'}` : `n/a (${version.error})`)

  // 1. Health + retention window (how far back getEvents/getTransaction can see)
  if (health.result) {
    const h = health.result
    const win = h.ledgerRetentionWindow ?? (h.latestLedger - h.oldestLedger)
    out.retention = win
    row('health', mark(h.status === 'healthy'), `${h.status} | retention ${win} ledgers (~${days(win)})`)
  } else row('health', 'FAIL', health.error)

  // 2. Live state: getLedgerEntries (account + native SAC instance)
  const sac = nativeSacId(passphrase)
  const usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  const keys = [contractInstanceKeyXdr(sac)]
  if (net === 'mainnet') keys.push(accountKeyXdr(usdcIssuer))
  const le = await call('getLedgerEntries', { keys })
  const found = le.result?.entries?.length ?? 0
  row('getLedgerEntries', mark(found === keys.length), le.error ?? `${found}/${keys.length} entries | ${le.ms}ms`)

  // 3. Fee stats (used when building txs)
  const fee = await call('getFeeStats')
  row('getFeeStats', mark(!fee.error), fee.error ?? `soroban p50 ${fee.result.sorobanInclusionFee?.p50} stroops`)

  // 4. History reach: getEvents worst case (filter matches nothing → full scan)
  const tip = latest.result?.sequence
  const reaches = [1_000, 8_000, 12_000, LEDGERS_PER_DAY, 3 * LEDGERS_PER_DAY, (out.retention ?? 120_960) - 200]
  let maxOk = 0
  for (const reach of reaches) {
    const ev = await call('getEvents', {
      startLedger: tip - reach,
      filters: [{ type: 'contract', contractIds: [sac], topics: [[TRANSFER_TOPIC, NEVER_MATCH, '*', '*']] }],
      pagination: { limit: 10 },
    }, 60_000)
    const ok = !ev.error
    if (ok) maxOk = reach
    row(`getEvents reach ${days(reach)}`, mark(ok), ok ? `${ev.ms}ms` : `${ev.error} (${ev.ms}ms)`)
    if (!ok) break
  }
  out.eventsReach = maxOk

  // 5. Deep history: getLedgers / getTransactions near genesis ("infinite scroll" / archive)
  const deep = await call('getLedgers', { startLedger: 1_000, pagination: { limit: 1 } })
  row('archive (getLedgers @1000)', deep.error ? 'INFO' : 'PASS', deep.error ? `no: ${deep.error.slice(0, 70)}` : 'yes — full ledger history')

  // 6. Latency: 10 sequential calls
  const lat = []
  for (let i = 0; i < 10; i++) lat.push((await call('getLatestLedger')).ms)
  out.p50 = pct(lat, 0.5)
  row('latency (10 seq)', 'INFO', `p50 ${pct(lat, 0.5)}ms | p95 ${pct(lat, 0.95)}ms`)

  // 7. Burst: N parallel calls, count throttles/failures
  const results = await Promise.all(Array.from({ length: burst }, () => call('getLatestLedger')))
  const fails = results.filter((r) => r.error)
  const throttled = results.filter((r) => r.status === 429).length
  out.burstFail = fails.length
  row(`burst (${burst} parallel)`, mark(fails.length === 0),
    fails.length ? `${fails.length} failed (${throttled}× 429) e.g. ${fails[0].error}` : 'all ok')

  console.log(`\n${url}`)
  console.log(lines.join('\n'))
  return out
}

// ---------- main ----------
const args = process.argv.slice(2)
if (!args.length) {
  console.log('usage: node scripts/rpc-probe.mjs <rpcUrl> [--header "Name: value"] [--burst N] [<rpcUrl> ...]')
  process.exit(1)
}
let headers = {}
let burst = 25
const targets = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--header') {
    const [k, ...v] = args[++i].split(':')
    headers = { ...headers, [k.trim()]: v.join(':').trim() }
  } else if (args[i] === '--burst') burst = Number(args[++i])
  else targets.push({ url: args[i], headers })
}

const results = []
for (const t of targets) results.push(await probe(t.url, t.headers, burst))

// Freshness: sample every endpoint's tip at the same moment, compare within a network
const reachable = results.filter((r) => r.net)
const tips = await Promise.all(
  reachable.map((r) => rpc(r.url, targets.find((t) => t.url === r.url).headers, 'getLatestLedger'))
)
reachable.forEach((r, i) => { r.latest = tips[i].result?.sequence })
const byNet = {}
for (const r of reachable) if (r.latest) (byNet[r.net] ??= []).push(r)
for (const [net, rs] of Object.entries(byNet)) {
  if (rs.length < 2) continue
  const max = Math.max(...rs.map((r) => r.latest))
  console.log(`\nfreshness (${net}): ` + rs.map((r) => `${new URL(r.url).host} −${max - r.latest}`).join(', '))
}
