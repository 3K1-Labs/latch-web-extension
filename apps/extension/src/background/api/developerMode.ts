import { setDeveloperMode } from '../storage'
import { clearCachedActiveNetwork, setActiveNetwork } from '../network/config'
import { clearNetworkScopedMemoryCaches } from '../network/clearCaches'
import { broadcastActiveAccountChanged, broadcastNetworkChanged } from '../dappProviderEvents'
import { clearWebauthnSession } from './webauthnSession'
import { BackendError } from './client'
import {
  clearLatchApiSuccess,
  DEVELOPER_MODE_COLD_START_MS,
  noteLatchApiSuccess,
  productionLatchApiBaseUrl,
  stagingLatchApiBaseUrl,
} from './config'

export type DeploymentNetwork = 'testnet' | 'mainnet'

type HealthBody = { status?: unknown; network?: unknown }

function healthError(baseUrl: string, expected: DeploymentNetwork, detail: string): BackendError {
  return new BackendError(
    `GET ${baseUrl}/health ${detail} Expected network "${expected}". Developer mode was not changed.`,
    { code: 'developer_mode_network' }
  )
}

/** Confirms the deployment reports the network this toggle requires. No other request is sent. */
export async function assertDeploymentHealth(
  baseUrl: string,
  expected: DeploymentNetwork
): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DEVELOPER_MODE_COLD_START_MS)
  try {
    let res: Response
    try {
      res = await fetch(`${baseUrl}/health`, { method: 'GET', signal: ctrl.signal })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw healthError(baseUrl, expected, 'timed out.')
      }
      throw healthError(
        baseUrl,
        expected,
        `failed (${err instanceof Error ? err.message : String(err)}).`
      )
    }

    const text = await res.text()
    let body: HealthBody
    try {
      body = text ? (JSON.parse(text) as HealthBody) : {}
    } catch {
      throw healthError(baseUrl, expected, `returned non-JSON (${res.status}).`)
    }

    if (!res.ok || body.status !== 'ok') {
      const got = typeof body.status === 'string' ? body.status : String(res.status)
      throw healthError(baseUrl, expected, `reported status "${got}".`)
    }
    if (body.network !== expected) {
      const got = typeof body.network === 'string' ? body.network : 'missing'
      throw healthError(baseUrl, expected, `reported network "${got}".`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Writes `latch.developerMode` only after `/health` reports the required network.
 * Enable requires testnet (staging). Disable requires mainnet (production).
 * The public wallet network matches that deployment. The in-flight WebAuthn
 * session is dropped so a ceremony cookie is not sent to the other host.
 * Stored `sid` cookies stay on their own host.
 */
export async function applyDeveloperMode(enabled: boolean): Promise<void> {
  if (enabled) {
    const staging = stagingLatchApiBaseUrl()
    if (!staging) {
      throw new BackendError(
        'Developer mode requires PLASMO_PUBLIC_LATCH_STAGING_API_URL. Expected network "testnet". Developer mode was not changed.',
        { code: 'developer_mode_network' }
      )
    }
    await assertDeploymentHealth(staging, 'testnet')
    await setDeveloperMode(true)
    clearCachedActiveNetwork()
    await setActiveNetwork('testnet')
    clearNetworkScopedMemoryCaches()
    await clearWebauthnSession()
    await broadcastNetworkChanged('testnet')
    await broadcastActiveAccountChanged()
    await noteLatchApiSuccess()
    return
  }

  const production = productionLatchApiBaseUrl()
  await assertDeploymentHealth(production, 'mainnet')
  await setDeveloperMode(false)
  clearCachedActiveNetwork()
  await setActiveNetwork('mainnet')
  clearNetworkScopedMemoryCaches()
  await clearWebauthnSession()
  await broadcastNetworkChanged('mainnet')
  await broadcastActiveAccountChanged()
  await clearLatchApiSuccess()
}
