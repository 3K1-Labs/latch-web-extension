# Changelog

## 0.1.0

First public release of `@uselatch/sdk`.

- `getLatchSDK()` wraps the injected `window.latch` provider: `isConnected`, `getPublicKey`, native and SEP-0043 `signTransaction`, `openSignRequest`, `getNetwork`, `getAddress`, `getNetworkDetails`, `disconnect`, `on`, and `off`.
- `LatchModule` adapts that provider to Stellar Wallets Kit. `signAuthEntry` and `signMessage` throw because the provider does not expose them yet.
- The published package has no runtime dependencies. dApp-facing types ship with the package.
