/**
 * Canonical public method names on `window.latch` / `getLatchSDK()`.
 * Keep this list in sync with `LatchSDK` and the injected provider.
 *
 * Bridge-only methods (`ping`) and the internal install mark are excluded.
 */
export const LATCH_PUBLIC_METHODS = [
  'isConnected',
  'getPublicKey',
  'signTransaction',
  'openSignRequest',
  'getNetwork',
  'getAddress',
  'getNetworkDetails',
  'disconnect',
  'on',
  'off',
] as const

export type LatchPublicMethod = (typeof LATCH_PUBLIC_METHODS)[number]
