# Latch — AGENTS.md

AI coding agent context for the Latch monorepo.

## What is Latch

Latch is a Stellar/Soroban smart account browser extension wallet built with Plasmo.

## Monorepo Layout

```
apps/
  extension/   # Plasmo browser extension (MV3)
  web/         # Landing site (future)
packages/
  types/       # Shared TS types — no runtime code
  stellar/     # Stellar/Soroban client logic (XDR, RPC, tx lifecycle)
  crypto/      # Key derivation + AES-GCM vault — background SW only
  ui/          # Shared React UI components
  sdk/         # Public dapp API (window.latch)
```

## Extension Execution Contexts

| Context        | File                                                         | Rule                                                                                    |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Popup          | `apps/extension/src/popup/index.tsx`                         | Primary UI surface. No key material. Sends messages to background.                      |
| Side panel     | `apps/extension/src/sidepanel/index.tsx`                     | Same rules as popup: no key material; messages to background only.                      |
| Background SW  | `apps/extension/src/background/index.ts` (+ `*/handlers.ts`) | ONLY context allowed to hold keys / sign. Message routing is a thin `tryHandle*` chain. |
| Content Script | `apps/extension/src/contents/injector.ts`                    | Proxy only. Bridges dapp ↔ background.                                                  |

**Never import `@latch/crypto` outside the background service worker.**

### Popup vs side panel (feature parity)

- Wallet UX is implemented in **`apps/extension/src/ui/LatchRoot.tsx`** (shell: accounts hydrate, routing, shared portfolio/history, overlays) plus feature **`*RouteViews`** under `apps/extension/src/ui/{swap,send,accounts,dapp,multisig}/` and screens under `apps/extension/src/ui/screens/*`. Route types and WebAuthn mount helpers live in [`apps/extension/src/ui/routing/routes.ts`](apps/extension/src/ui/routing/routes.ts). Both **popup** and **side panel** mount the same `LatchRoot` tree with a `surface` prop (`"popup"` | `"sidepanel"`) for layout only.
- **Do not ship flows that work in one surface but not the other** unless you document an explicit, product-approved exception in this file. Onboarding, passkey create/login, settings, and signing flows must behave the same in popup and side panel.
- Avoid long `await` chains between a **user click** and **`navigator.credentials`** (WebAuthn): transient user activation is easier to lose in the side panel than in the popup; keep pre-credential work minimal.
- **Do not swap the whole route for a generic loading screen** between the click and WebAuthn: unmounting the control that received the gesture can prevent the passkey UI from appearing (especially in the side panel). Keep passkey-related screens mounted and use inline disabled/busy state instead (see `routeKeepsUiMountedForWebauthn` in [`routing/routes.ts`](apps/extension/src/ui/routing/routes.ts)).
- **Side panel WebAuthn**: Chrome often does not complete `navigator.credentials` in the side panel (hangs with no OS prompt). Latch **prefetches** `/begin` on the Create / Passkey-login screens, then runs `startRegistration` / `startAuthentication` in a small **`tabs/passkey-bridge`** extension popup (`chrome.windows` + `chrome.storage.session` handoff) via [`runWebauthnCredential`](apps/extension/src/ui/webauthn/runWebauthnCredential.ts). The action toolbar **popup** keeps in-page WebAuthn. Both surfaces use the same backend finish calls.

## Tech Stack

- Package manager: pnpm (workspaces)
- Build orchestration: Turbo
- Extension framework: Plasmo (MV3)
- Language: TypeScript strict mode
- React 18

## Key Conventions

- All inter-context communication via `chrome.runtime.sendMessage`
- Message types defined in `@latch/types` (`MessageType`, `BackgroundMessage`, `BackgroundResponse`)
- Network config via `PLASMO_PUBLIC_*` env vars. Outbound HTTP lives in [`apps/extension/src/background/api/*`](apps/extension/src/background/api/); [`backend.ts`](apps/extension/src/background/backend.ts) re-exports the public API. **`PLASMO_PUBLIC_LATCH_API_URL`** defaults to `https://latch-backend.onrender.com` (Render Go backend). **`PLASMO_PUBLIC_LATCH_MARKET_API_URL`** defaults to `{LATCH_API_URL}/v1` when unset. Local dev: set to `http://localhost:3000` and ensure `apps/extension/package.json` `manifest.host_permissions` includes that origin.
- Stellar network: testnet by default during development
- All icons SVGs should never be written from scratch, prefer importing icons that fit the task.
- Use lucide icons or icon svgs if provided
- Keep UI code clean and modular: avoid large monolithic screen files. Prefer extracting reusable UI building blocks into `apps/extension/src/ui/components/*` or feature-local folders (e.g. `apps/extension/src/ui/swap/components/*`) once a screen grows beyond a few small helpers.
- **Pixel-perfect UI from designs is mandatory**:
  - Do not invent spacing, typography, shadows, gradients, layouts, or components that are not explicitly shown in the design.
  - Prefer using the exact design-provided image/assets when pixel accuracy is required.
  - If any design detail is ambiguous or missing (dimensions, states, interactions), **ask for clarification** before implementing.

## Data fetching & API requests (Plasmo / MV3 best practices)

### Golden rule: fetch in the right context

- **Popup / side panel UI (`apps/extension/src/popup/*`, `apps/extension/src/sidepanel/*`, `apps/extension/src/ui/*`)**: UI-only. No secrets. **Do not** talk to RPCs/APIs directly except for truly public, low-risk reads (and even then, prefer the background for consistency).
- **Content script (`apps/extension/src/contents/*`)**: proxy only. **Never** fetch from the page context and never embed business logic. Bridge dapp ↔ background.
- **Background service worker (`apps/extension/src/background/index.ts` + feature `*/handlers.ts`)**: **the place for network + privileged work**:
  - signing, vault access, key derivation
  - RPC/API requests that depend on user state, authorization, rate-limits, or consistency
  - caching, de-duping, retries/backoff, request cancellation
  - message routing: thin `tryHandle*` chain (accounts, tx, reads, swap, migration, network, dapp, onboarding, plus existing multisig/v1Auth/deposit)

### Architecture: one network “edge” in the background

- **Single entrypoint**: implement all outbound HTTP/RPC calls behind a small background “API layer” (e.g. `apps/extension/src/background/api/*`).
- **UI talks in messages, not URLs**: popup asks for _intent_ (“get balances”, “simulate tx”, “create passkey”) via typed messages; background returns typed responses.
- **No duplicated clients**: avoid creating separate fetch/RPC clients in popup, sidepanel, and background. Centralize in background and expose a message API.

### Fetch implementation guidance (clean + reliable)

- **Use a typed request/response contract**:
  - define message payloads + responses in `@latch/types`
  - keep background handlers narrow and explicit per `MessageType`
- **Make requests cancellable**:
  - popup/side panel sends an optional `requestId` on long reads (balances, history, swap quote)
  - UI calls `CANCEL_REQUEST` with the same id on unmount, account switch, or superseded fetch
  - background registers an `AbortController` per `requestId` and races the **waiter** (not shared inflight I/O) — always `sendResponse({ ok: false, error: { code: 'cancelled' } })` on cancel; never swallow abort without responding
  - **Do not abort shared inflight** Horizon/RPC or quote-cache promises other waiters still need; cancel detaches only the message waiter
  - v1: swap quote provider HTTP is not aborted on cancel (waiter-only); document if extending
  - never cancel WebAuthn / signing mid-ceremony
  - handler template: `withCancellableWaiter(req.requestId, () => runGet…())` in reads/swap handlers; see `requestRegistry.ts` + `requestWaiter.ts`
- **De-dupe in-flight requests**:
  - if multiple UI renders ask for the same resource, background should reuse the same promise keyed by (endpoint, params, network)
- **Cache where it matters**:
  - cache public, frequently-read data (e.g. account state) in background memory with a short TTL
  - persist only non-sensitive derived data (e.g. last-known balances) to `chrome.storage.local` if it improves UX on cold start
- **Handle errors consistently**:
  - background should map low-level errors into a stable, serializable error shape (code/message) for the UI
  - UI should render friendly states and avoid leaking raw stack traces
- **Respect MV3 service worker constraints**:
  - the SW can be suspended; don’t rely on long-lived in-memory state as the only source of truth
  - persist required non-secret state to `chrome.storage.local` and rehydrate as needed

### What NOT to do (networking)

- Don’t fetch from `apps/extension/src/popup/*` or `apps/extension/src/sidepanel/*` for anything that depends on user state, auth, or signing.
- Don’t add fetch logic to content scripts or the injected page bridge.
- Don’t scatter ad-hoc `fetch()` calls across UI components; route them through background handlers.
- Don’t store secrets/tokens in `chrome.storage` from the UI; secrets live only in the vault and are accessed only in background.

## Refined UI + UX Patterns (extension surfaces)

### Onboarding flow (popup and side panel)

Onboarding and home UI live in **`apps/extension/src/ui/LatchRoot.tsx`**, mounted from **`popup/index.tsx`** and **`sidepanel/index.tsx`** with the same behavior (see [Popup vs side panel](#popup-vs-side-panel-feature-parity)).

State is stored in `chrome.storage.local` (no secrets):

- `latch.setupState`: `"new" | "onboarding_done" | "has_account"`
- `latch.accountPublicKey`: optional (public info only)

Render onboarding until `setupState === "has_account"`, then the dashboard/home UI.

### Account list identity (do not widen)

The Latch API identifies callers by an anonymous **`sid` cookie** that survives reinstalls and mints a new user when absent, so "what the API returns for this cookie" is **not** "what belongs to this user". The account list must be scoped to signers this install has actually proved. Full analysis and the backend fix: [`LATCH_BACKEND_ACCOUNT_IDENTITY.md`](LATCH_BACKEND_ACCOUNT_IDENTITY.md).

Rules to preserve:

- **`PASSKEY_AUTH_FINISH` persists only the credential that completed the ceremony.** Never loop over `data.accounts` and upsert siblings — that list is every account on the cookie user.
- **Multisig sync requires a local signer.** `syncLocalMultisigAccountsFromBackend` imports a listed wallet only when a member matches a local passkey/seed (`remoteMultisigMatchesLocalSigner`); creator-only rows are skipped. With no local signer it imports nothing.
- **Empty account store clears `sid`** (fresh install or last account removed), as does `LOGOUT`. Use `clearLatchApiSession()`.
- **Removal is local only.** `DELETE_ACCOUNT` drops the `StoredAccount` and records the address in the per-network denylist (`latch.removedAccounts.byNetwork`) so sync cannot resurrect it. It never leaves the on-chain wallet or removes a multisig signer. An explicit re-add clears the denylist entry.

### WebAuthn / passkey (Chrome extension)

Passkeys use a **shared HTTPS-domain RP ID** so the same credential can work in the Chrome extension, a future Latch website, and associated native apps.

- **RP ID:** `PLASMO_PUBLIC_WEBAUTHN_RP_ID` (default `uselatch.app`). Hostname only — never `chrome.runtime.id`.
- **Origins:** ceremonies from the extension produce `clientDataJSON.origin = chrome-extension://<chrome.runtime.id>`. Web ceremonies use `https://uselatch.app`. The Latch API must allowlist both as `expectedOrigins` while always verifying `expectedRPID` = the domain.
- The background still sends **`chromeExtensionId`** (`chrome.runtime.id`) on WebAuthn-related API calls as an **origin hint only** — not as `rp.id`.

**Contract for the Latch API** (registration begin/finish, authentication begin/finish, and any route that verifies WebAuthn assertions):

- Always set **`rp.id` / `rpId`** = `WEBAUTHN_RP_ID` (`uselatch.app`), for both web and extension clients.
- When `chromeExtensionId` is present, include **`chrome-extension://<chromeExtensionId>`** in **`expectedOrigins`** (do **not** set `expectedRPID` to the extension id).
- Also allow `https://uselatch.app` in `expectedOrigins`.
- Prefer the finish-body `chromeExtensionId` if session storage is unreliable.

Full backend cutover guide: [`LATCH_BACKEND_DOMAIN_WEBAUTHN_RPID.md`](LATCH_BACKEND_DOMAIN_WEBAUTHN_RPID.md).

The extension merges **`chromeExtensionId`** into begin, registration finish, authentication finish, and **`submitTxWebauthn`** request bodies from [`api/webauthn.ts`](apps/extension/src/background/api/webauthn.ts) and [`api/transactions.ts`](apps/extension/src/background/api/transactions.ts). The UI asserts server-issued **`rp.id` / `rpId`** matches **`latchWebauthnRpId()`** before calling `startRegistration` / `startAuthentication` (see [`passkey.ts`](apps/extension/src/ui/webauthn/passkey.ts) → `assertBeginOptionsRpIdMatchesCanonicalDomain`). Extension manifest must include host permission `https://uselatch.app/*` so Chrome can claim that RP ID from extension pages.

### dApp external-sign review (hybrid)

dApp `signTransaction` / sign-request review uses **wallet-side XDR decode** for what the user sees (`parseTxForReview` / `assessExternalSignReview` in `@latch/stellar`). The review list must not trust `prepare-sign` `operations[]` (often empty on the Go API).

- **`prepare-sign` remains mandatory** for auth templates, digests, and signing. Confirm still consumes `prepared` via `signAndSubmitBuiltTx` / `signWithoutSubmitBuiltTx`.
- **Consistency checks** (network, active smart account `C…`, invoke contract id sets from unsigned XDR vs `prepared.txXdr`) hard-block Confirm when they disagree. Compare contract ids — not raw XDR string equality.
- **Fail closed** if Latch API / `prepare-sign` is down: no review and no “review anyway” path. Client-side simulate is out of scope.
- Popup, side panel, and `tabs/sign-request.tsx` all render the same `localReview` payload from `prepareExternalSignSession`.

### Multisig wallets (`/api/multisig` — shipped)

**Live product path** uses cookie-session **`/api/multisig/*`** (draft → join → deploy → proposals). Orchestrated in [`MultisigRouteViews.tsx`](apps/extension/src/ui/multisig/MultisigRouteViews.tsx) via `MULTISIG_*` messages and [`tryHandleMultisigMessage`](apps/extension/src/background/multisig/handlers.ts).

- Deployed multisig wallets are **`StoredAccount`** entries with **`mode: 'multisig'`**. They reuse **`GET_SMART_ACCOUNT_BALANCES`**, history, and account switching like passkey wallets.
- **Session fields on `StoredAccount`**: `multisigMemberId`, `multisigBackendAccountId`, `multisigThreshold` (required for approve/execute). Optional cosign fields (`cosignWckRefId`, etc.) may exist on disk but are **not used** by the live path.
- **Routes** (popup + side panel): `createMultisig`, `addMultisigOwners`, `multisigThreshold`, `multisigReviewDeploy`, `multisigSuccess`, `addExistingMultisig`, `joinMultisig`, `multisigWallets`, `multisigProposals`, `multisigProposalDetail`.
- **Add existing wallet**: Settings → View Accounts → Add → **Add existing MultiSig** routes to `addExistingMultisig`. **`MULTISIG_ADD_EXISTING_ACCOUNT`** proves membership in the background (backend member row matching a local signer, else a read-only on-chain read of the Default context rule in [`onchainSigners.ts`](apps/extension/src/background/multisig/onchainSigners.ts)) and **fails closed** for non-signers. UI never touches RPC.
- **Create flow**: `MULTISIG_CREATE_DRAFT` → co-owners (**Add my passkey**, paste `G…`, or invite link `?multisigJoin=` / legacy `?cosignJoin=`) → threshold → predict → **`POST /api/multisig/drafts/{id}/deploy`** → local account + `MULTISIG_LIST_ACCOUNTS` sync.
- **Join flow**: deep link or Settings → Multisig Wallets; [`MultisigJoinFlow`](apps/extension/src/ui/multisig/MultisigJoinFlow.tsx) uses **`MULTISIG_JOIN_*`**, then pending invite + sync so members get `smartAccountAddress` + `multisigMemberId`.
- **Send**: when the active account is multisig, Send creates a backend proposal via `createMultisigSendProposalWithSetup` (`MULTISIG_CREATE_PROPOSAL`). **Swap is disabled** for multisig accounts.
- **Proposals**: list/detail; approve via [`multisigApprove.ts`](apps/extension/src/ui/lib/multisigApprove.ts); execute via **`MULTISIG_EXECUTE_PROPOSAL`** when threshold met.
- **Side panel WebAuthn**: use **passkey-bridge** for join and proposal approve. Routes that trigger WebAuthn must stay mounted — see `routeKeepsUiMountedForWebauthn` in [`routing/routes.ts`](apps/extension/src/ui/routing/routes.ts) (`addMultisigOwners`, `joinMultisig`, `multisigProposalDetail`).

**Cosign / `/v1/cosign` — superseded / not shipped.** Source under `background/cosign/*`, `ui/lib/cosign*`, and `CosignRouteViews` remains on disk but is **unwired** from `background/index.ts` and `LatchRoot`. Do not route new product work through cosign; see [`LATCH_BACKEND_COSIGN_EXTENSION.md`](LATCH_BACKEND_COSIGN_EXTENSION.md).

## Styling: TailwindCSS (extension-friendly)

We standardize on **TailwindCSS** for extension UI (popup, side panel, and other extension pages) because it:

- compiles to static CSS at build time (MV3/CSP friendly)
- accelerates design-heavy UI iteration

Guidelines:

- Tailwind config lives at `apps/extension/tailwind.config.ts`
- PostCSS config lives at `apps/extension/postcss.config.js`
- Global Tailwind entry CSS at `apps/extension/src/style.css` (imported from `apps/extension/src/ui/LatchRoot.tsx`, shared by popup and side panel entrypoints)
- Ensure Tailwind `content` includes `./src/**/*.{ts,tsx}` so unused classes purge correctly.

### Font: SF Pro Rounded

We bundle **SF Pro Rounded** so typography is consistent on all platforms (not only macOS/iOS).

- Font files: `apps/extension/assets/fonts/` (weights 400, 500, 600, 700, 800, 900 — no italics)
- `@font-face` declarations: `apps/extension/src/fonts.css` (imported from `apps/extension/src/style.css`)
- Tailwind default sans stack: `fontFamily.sans` in `apps/extension/tailwind.config.ts`
- Use existing Tailwind weight utilities (`font-medium`, `font-semibold`, `font-bold`, `font-extrabold`, etc.); keep `font-mono` for addresses/keys
- SF Pro is Apple-licensed; shipping these files is an explicit product choice

### Theme system (light/dark)

Default theme is **dark**. We use lightweight CSS variables (to keep Tailwind classes stable):

- Tokens live in `apps/extension/src/style.css` as `--latch-*`
- Light mode is enabled by toggling `document.documentElement.classList.toggle("theme-light", true)`
- Persist user preference in `chrome.storage.local`:
  - `latch.theme`: `"dark" | "light"`

Design tokens (current):

- Dark bg: `#1F1F1F`
- Primary: `#FFAD00`
- Dark surface: `#090909`
- Dark border: `#2B2A29` (secondary button + card borders)
- Light bg: `#F5F4F4`
- Light surface: `#FFFFFB`

### Asset paths (keep stable)

Prefer shipping reusable SVG/PNG assets under `apps/extension/assets/` and referencing them by relative URL from UI code:

- Logo: `apps/extension/assets/brand/latch-logo.svg`
- Icons: `apps/extension/assets/icons/*.svg` (e.g. `biometrics.svg`)
- Avatars: `apps/extension/assets/avatars/*.png` (e.g. `success.png`)

Avoid inlining large SVG blobs in TSX; prefer `<img src=\"../../assets/...\">` to keep code/token usage small and consistent across repos.

### Main bottom navigation (`MainBottomNav`)

- Mounted from `LatchRoot` on main tab routes (**home**, **swap**, **history**, **explore**) unless a screen explicitly opts out.
- **Background must be solid and opaque** — Figma `card-bg-2` / `#222121`. Use `bg-[#222121]` (or `bg-[rgb(var(--latch-surface-2))]`). **Never** ship a transparent, translucent, or inherited-background nav bar; content scrolling behind the nav must not show through.
- Tab screens that show the nav need `pb-[74px]` on their scroll root so content clears the 74px bar.
- Preserve per-tab active styling (primary label + active icon variant where assets exist).

### Popup polish checklist

- If you see unthemed “white space” during scroll/overscroll, ensure `html, body { background: rgb(var(--latch-bg)); overscroll-behavior: none; }` in `apps/extension/src/style.css`.

### Animations (CSS-only)

Use Tailwind keyframes in `apps/extension/tailwind.config.ts` (no new deps) and apply via `animate-*` classes.

### Content-script UI styling (future)

If/when we render UI inside arbitrary websites:

- Prefer style isolation (Shadow DOM / Plasmo CSUI patterns) to avoid CSS collisions.
- Bundle Tailwind CSS with the injected UI rather than relying on host page styles.

## Commands

```bash
pnpm setup       # install all deps
pnpm dev         # start extension in watch mode
pnpm build       # production build
pnpm lint        # lint all packages
pnpm test        # run all tests
pnpm format      # prettier across repo
```

## What NOT to do

- Do not add MetaMask-style middleware stacks — not needed for Stellar
- Do not sign transactions in the popup or content script
- Do not store raw private keys in chrome.storage — vault must be encrypted
- Do not add Redux — use context or Zustand at the right scope
