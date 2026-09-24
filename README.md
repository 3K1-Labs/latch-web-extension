# Latch

Non-custodial **Stellar / Soroban smart-account** wallet as a Chrome MV3
browser extension ([Plasmo](https://docs.plasmo.com)).

New here? Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Stack

- **Extension**: Plasmo (MV3), React 18
- **Packages**: pnpm workspaces + Turbo
- **Chain**: Stellar / Soroban (testnet by default in development)

## Repository layout

```
apps/extension    # Browser extension (popup, side panel, background, content script)
packages/
  types           # Shared TypeScript types (no runtime)
  stellar         # Stellar / Soroban client
  swap            # Swap quote / build helpers
  sdk             # Public dapp API (window.latch)
  crypto          # Stub — vault and mnemonic live in the background service worker
  ui              # Stub — UI lives in apps/extension/src/ui
```

Architecture and coding conventions: [AGENTS.md](AGENTS.md).

## Prerequisites

- Node.js 20 (`nvm use` — see `.nvmrc`)
- pnpm 10.33.0
- Chrome (to load the unpacked extension)

## Getting started

```bash
pnpm setup
pnpm dev
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
select `apps/extension/build/chrome-mv3-dev`.

Optional env overrides: copy [`apps/extension/.env.example`](apps/extension/.env.example)
to `apps/extension/.env`. All `PLASMO_PUBLIC_*` values are public config, not
secrets. Defaults talk to the hosted Latch API; see CONTRIBUTING for local API.

| Command             | Purpose                           |
| ------------------- | --------------------------------- |
| `pnpm setup`        | Install workspace dependencies    |
| `pnpm dev`          | Plasmo watch build                |
| `pnpm build`        | Production / typecheck via Turbo  |
| `pnpm lint`         | ESLint                            |
| `pnpm test`         | Vitest (extension, stellar, swap) |
| `pnpm format`       | Prettier write                    |
| `pnpm format:check` | Prettier check (CI)               |

## Mnemonic import (Stellar smart account)

The extension can derive a Stellar **Ed25519** keypair from a **BIP-39** English
mnemonic (optional BIP-39 passphrase) entirely inside the extension service
worker:

- **HD path**: `m/44'/148'/0'` (Stellar convention, **SLIP-0010** Ed25519 child
  key derivation).
- **Libraries**: `@scure/bip39` for mnemonic validation and seed;
  `ed25519-hd-key` for SLIP-0010; `@stellar/stellar-sdk`
  `Keypair.fromRawEd25519Seed` for the Stellar `G…` address.

**Security model**

- The mnemonic, BIP-39 seed, and private key material are **never** sent to the
  Latch backend or logged.
- Only the derived **`gAddress`** (`G…`) is used over HTTPS:
  `GET /api/smart-account/freighter?gAddress=…` to predict status, then
  `POST /api/smart-account/freighter` with `{ "gAddress" }` if the smart account
  is not yet deployed — the same delegated-signer flow as Freighter-backed
  accounts.
- By default the phrase is **not** persisted. Optional **Remember** stores an
  **AES-GCM** ciphertext (PBKDF2-derived key from a user-chosen password) in
  `chrome.storage.local`; the user must **unlock** after an MV3 service-worker
  restart to load the signing key again.

Implementation lives under `apps/extension/src/background/` (e.g.
`stellarMnemonic.ts`, `delegatedLocalSign.ts`, `mnemonicVault.ts`).

## dApp API (`window.latch` / `@latch/sdk`)

Latch injects `window.latch` on every page. Use `@latch/sdk` (`getLatchSDK()`) as a thin
wrapper in bundled dApps.

**Latch-native (stable):**

- `getPublicKey()` → smart-account `C…` string
- `signTransaction({ xdr, network, accountToSign, submit? })` → waits for the user and
  resolves with `txHash` (when `submit: true`) or signed XDR
- `openSignRequest({ network, account, callback, requestId, xdr? | payloadRef?, submit? })` →
  opens the extension sign-request tab and later delivers the result to `callback`
  (promise resolves once the tab is open; does not return the signed payload to the page)
- `getNetwork()` → `'testnet' | 'mainnet'`
- `disconnect()` → revokes this origin's access; the next `getPublicKey()` / `getAddress()`
  re-prompts GrantAccess. Accounts and other origins are untouched, and no event is emitted,
  so clear your own session state. `isConnected()` still only means "extension installed".

**SEP-0043 interop (added alongside native methods):**

- `getAddress()` → `{ address }` (same GrantAccess flow as `getPublicKey()`)
- `signTransaction(xdr, opts?)` → `{ signedTxXdr, signerAddress }` (sign-only in v1)
- `getNetworkDetails()` → `{ network: 'TESTNET' | 'PUBLIC', networkPassphrase }`

**Integrator notes:**

- Latch addresses are Soroban smart-account **`C…`**, not classic **`G…`**. Pass the same
  `C…` as `opts.address` when using the SEP-shaped sign API.
- Prefer `signTransaction` when the dApp can await a promise on the page. Use
  `openSignRequest` for redirect / callback flows (Layer-2 style).
- SEP-shaped sign is sign-only in v1; the dApp submits `signedTxXdr`. `submit: true` and
  `submitUrl` return SEP error code `-3`. Latch-native `signTransaction` and
  `openSignRequest` may set `submit: true` so Latch broadcasts.
- SEP methods throw errors with numeric `code` (`-1`…`-4`); Latch-native methods use string
  codes.

**Stellar Wallets Kit:** add the module explicitly until Latch is included in the kit’s
default module list. The SDK is currently private, so partners should use a workspace or
path import until it is published:

```ts
import { StellarWalletsKit, WalletNetwork } from '@creit.tech/stellar-wallets-kit'
import { LatchModule } from '@latch/sdk'

const kit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  selectedWalletId: 'latch',
  modules: [new LatchModule()],
})

await kit.openModal()
kit.setWallet('latch')
const { address } = await kit.getAddress()
```

The module implements the kit’s `ModuleInterface` and reports Latch’s `C…` smart-account
address. `signAuthEntry` and `signMessage` fail explicitly because those provider methods
are not available yet; no key material is handled by the module.

See [`packages/sdk/src/index.ts`](packages/sdk/src/index.ts) for the full typed surface.

## More

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, PRs, AI policy
- [SECURITY.md](SECURITY.md) — vulnerability disclosure
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [LICENSE](LICENSE) — MIT (source). Bundled SF Pro Rounded fonts: see [NOTICE](NOTICE)
- [AGENTS.md](AGENTS.md) — execution contexts and conventions
