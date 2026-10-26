import { Asset } from '@stellar/stellar-sdk'

import type { PortfolioTokenProbe } from './smartAccountPortfolio'

export type StellarNetwork = 'testnet' | 'mainnet'

export type CuratedAsset = {
  code: string
  issuer?: string
  decimals?: number
}

/**
 * Latch FeeForwarder C-address per network (latch-relayer `GET /gasless/fee-tokens` →
 * `fee_forwarder`). `parseTxForReview` unwraps `forward()` only on this contract.
 * Mainnet is unset until that value is confirmed — never fall back to the testnet id.
 */
export const FEE_FORWARDER_CONTRACT_ID: Record<StellarNetwork, string | undefined> = {
  testnet: 'CCQXTY4EG56OP7APGGJSY5YITFNSXWB4EKPZ7KKMYEHW7BXIKW44HSTA',
  // Confirm against latch-relayer GET /gasless/fee-tokens → fee_forwarder before shipping unwrap.
  mainnet: undefined,
}

/** Network-canonical issuers for portfolio + swap probing (SAC derived at runtime). */
export const CURATED_PORTFOLIO_ASSETS: Record<StellarNetwork, CuratedAsset[]> = {
  testnet: [
    {
      code: 'USDC',
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      decimals: 7,
    },
    {
      code: 'EURC',
      issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
      decimals: 7,
    },
  ],
  mainnet: [
    {
      code: 'USDC',
      issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      decimals: 7,
    },
    {
      code: 'EURC',
      issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
      decimals: 7,
    },
  ],
}

export function curatedAssetToProbe(
  asset: CuratedAsset,
  networkPassphrase: string
): PortfolioTokenProbe | null {
  if (!asset.code) return null
  if (asset.code.toUpperCase() === 'XLM' && !asset.issuer) {
    return {
      code: 'XLM',
      sacContractId: Asset.native().contractId(networkPassphrase),
    }
  }
  if (!asset.issuer) return null
  try {
    return {
      code: asset.code,
      issuer: asset.issuer,
      sacContractId: new Asset(asset.code, asset.issuer).contractId(networkPassphrase),
    }
  } catch {
    return null
  }
}

export function curatedPortfolioProbes(
  networkPassphrase: string,
  network: StellarNetwork
): PortfolioTokenProbe[] {
  const probes: PortfolioTokenProbe[] = []
  for (const asset of CURATED_PORTFOLIO_ASSETS[network]) {
    const probe = curatedAssetToProbe(asset, networkPassphrase)
    if (probe) probes.push(probe)
  }
  return probes
}
