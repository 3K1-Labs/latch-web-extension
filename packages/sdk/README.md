# @uselatch/sdk

Public dApp API for the [Latch](https://latch.tech/) wallet. This package is a thin wrapper around the `window.latch` provider injected by the Latch browser extension. It does not sign, store keys, or talk to the network.

```bash
npm install @uselatch/sdk
```

## Detect and connect

`isConnected()` is true when the extension is installed and the page can reach it. It does not mean the user has granted this site access.

```ts
import getLatchSDK from '@uselatch/sdk'

const latch = getLatchSDK()

if (!(await latch.isConnected())) {
  throw new Error('Install the Latch extension')
}

const publicKey = await latch.getPublicKey()
```

`getPublicKey()` and `getAddress()` both run Grant Access and return the active Soroban smart-account address. That address is a contract address (`C…`), not a classic account (`G…`).

```ts
const { address } = await latch.getAddress()
```

## Network

- `getNetwork()` returns `'testnet' | 'mainnet'`.
- `getNetworkDetails()` returns the SEP-0043 shape `{ network: 'TESTNET' | 'PUBLIC', networkPassphrase }`.

## Sign a transaction

Latch-native `signTransaction` takes an object. When `submit` is omitted or `true`, Latch broadcasts and the result includes `txHash`. When `submit` is `false`, the result includes `signedTxXdr` and the dApp submits it.

```ts
const result = await latch.signTransaction({
  xdr,
  network: 'testnet',
  accountToSign: address,
  submit: false,
})
```

SEP-0043 `signTransaction(xdr, opts?)` is sign-only in 0.1.0. It returns `{ signedTxXdr, signerAddress }`. Pass the same `C…` as `opts.address`. `submit: true` and `submitUrl` fail with SEP error code `-3`. The dApp submits `signedTxXdr`.

```ts
const { signedTxXdr, signerAddress } = await latch.signTransaction(xdr, {
  networkPassphrase: 'Test SDF Network ; September 2015',
  address,
})
```

SEP methods throw errors with a numeric `code` (`-1` through `-4`). Latch-native methods use string error codes.

## Redirect signing

Use `openSignRequest` when the page cannot wait on the sign promise (redirect / callback flows). The promise resolves once the extension sign-request tab is open. The signed payload is delivered to `callback`, not returned to the page. `submit: true` is allowed here and Latch may broadcast.

```ts
await latch.openSignRequest({
  network: 'testnet',
  account: address,
  callback: 'https://dapp.example/callback',
  requestId: 'req-1',
  xdr,
})
```

## Disconnect

`disconnect()` revokes Latch access for the current origin only. The next `getPublicKey()` or `getAddress()` opens Grant Access again. Accounts and other origins stay as they are. Latch does not emit an event, so clear your own session state. `isConnected()` still only means the extension is installed.

## Account and network changes

```ts
latch.on?.('accountChanged', ({ publicKey, network }) => {
  // active account or the account event payload
})
latch.on?.('networkChanged', ({ publicKey, network }) => {
  // active network
})
```

## Stellar Wallets Kit

Add `LatchModule` yourself until Latch is in the kit's default module list. The module id is `latch`, the product URL is `https://latch.tech/`, and the icon is `https://raw.githubusercontent.com/3K1-Labs/latch-web-extension/main/apps/extension/assets/brand/latch-logo.svg`.

```ts
import { StellarWalletsKit, WalletNetwork } from '@creit.tech/stellar-wallets-kit'
import { LatchModule } from '@uselatch/sdk'

const kit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  selectedWalletId: 'latch',
  modules: [new LatchModule()],
})

await kit.openModal()
kit.setWallet('latch')
const { address } = await kit.getAddress()
```

`LatchModule.signAuthEntry` and `LatchModule.signMessage` throw in 0.1.0. Those methods are not on `window.latch` yet. The module never handles key material.

## Browser only

`getLatchSDK()` throws if it is called outside a browser, or if `window.latch` is missing.
