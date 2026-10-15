import {
  clearDeveloperModeLastOkAt,
  getDeveloperMode,
  getDeveloperModeLastOkAt,
  setDeveloperModeLastOkAt,
} from '../storage'

export const DEFAULT_LATCH_API_URL = 'https://latch-backend.onrender.com'

/** Health check and the first latch-api call after a staging cold start. */
export const DEVELOPER_MODE_COLD_START_MS = 35_000

/** Render free tier sleeps after about 15 minutes idle. */
export const DEVELOPER_MODE_IDLE_MS = 15 * 60 * 1000

/** Plasmo inlines `process.env.PLASMO_PUBLIC_*` at build time; keep a direct `process.env` reference. */
function trimBase(raw: string | undefined, fallback: string): string {
  const s = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback
  return s.replace(/\/$/, '')
}

export function productionLatchApiBaseUrl(): string {
  return trimBase(
    process.env.PLASMO_PUBLIC_LATCH_API_URL as string | undefined,
    DEFAULT_LATCH_API_URL
  )
}

/** Staging deployment. Empty when the build has no developer-mode target. */
export function stagingLatchApiBaseUrl(): string | undefined {
  const raw = process.env.PLASMO_PUBLIC_LATCH_STAGING_API_URL as string | undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return raw.trim().replace(/\/$/, '')
}

/**
 * Production URL, or the staging URL when developer mode is on.
 * Throws before any fetch when developer mode is on and staging is unset.
 */
export async function latchApiBaseUrl(): Promise<string> {
  if (!(await getDeveloperMode())) return productionLatchApiBaseUrl()
  const staging = stagingLatchApiBaseUrl()
  if (!staging) {
    throw new Error(
      'Developer mode requires PLASMO_PUBLIC_LATCH_STAGING_API_URL. No request was sent.'
    )
  }
  return staging
}

/** Market API base. Developer mode always follows the selected latch-api base (`{base}/v1`). */
export async function latchMarketApiBaseUrl(): Promise<string> {
  if (await getDeveloperMode()) {
    return `${await latchApiBaseUrl()}/v1`
  }
  const marketRaw = process.env.PLASMO_PUBLIC_LATCH_MARKET_API_URL as string | undefined
  if (typeof marketRaw === 'string' && marketRaw.trim() !== '') {
    return marketRaw.trim().replace(/\/$/, '')
  }
  return `${productionLatchApiBaseUrl()}/v1`
}

/**
 * Caller-supplied timeouts win. In developer mode, the first call after idle
 * uses the cold-start budget so a staging wake is not treated as a failure.
 */
export async function latchRequestTimeoutMs(
  explicit: number | undefined,
  fallbackMs: number
): Promise<number> {
  if (explicit != null) return explicit
  if (!(await getDeveloperMode())) return fallbackMs
  const last = await getDeveloperModeLastOkAt()
  const idle = last == null || Date.now() - last > DEVELOPER_MODE_IDLE_MS
  return idle ? Math.max(fallbackMs, DEVELOPER_MODE_COLD_START_MS) : fallbackMs
}

export async function noteLatchApiSuccess(): Promise<void> {
  if (!(await getDeveloperMode())) return
  await setDeveloperModeLastOkAt(Date.now())
}

export async function clearLatchApiSuccess(): Promise<void> {
  await clearDeveloperModeLastOkAt()
}
