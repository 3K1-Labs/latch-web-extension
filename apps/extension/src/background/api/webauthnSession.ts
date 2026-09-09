import { latchApiBaseUrl } from './config'

const WEBAUTHN_SESSION_KEY = 'latch.webauthn.session.v1'

export type WebauthnSessionKind = 'registration' | 'authentication'

type WebauthnSession = {
  sid: string
  baseUrl: string
  chromeExtensionId: string
  startedAtMs: number
  kind: WebauthnSessionKind
  /** Challenge from `/begin` options; used to bind assertion → session before `/finish`. */
  challenge?: string
}

function sessionCookieUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/`
}

function parseSidFromSetCookieLine(line: string): string | undefined {
  const m = line.match(/(?:^|,\s*)sid=([^;,\s]+)/)
  return m?.[1]
}

/** Read `sid` from a fetch `/begin` response `Set-Cookie` header. */
export function extractSidFromFetchResponse(res: Response): string | undefined {
  const headers = res.headers
  if (!headers) return undefined

  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') {
    for (const line of getSetCookie.call(headers)) {
      const sid = parseSidFromSetCookieLine(line)
      if (sid) return sid
    }
  }
  const raw = headers.get('set-cookie')
  if (raw) {
    const sid = parseSidFromSetCookieLine(raw)
    if (sid) return sid
  }
  return undefined
}

async function readSidCookie(baseUrl: string): Promise<string | undefined> {
  try {
    if (typeof chrome === 'undefined' || !chrome.cookies?.get) return undefined
    const cookie = await chrome.cookies.get({ url: sessionCookieUrl(baseUrl), name: 'sid' })
    return cookie?.value
  } catch {
    return undefined
  }
}

function chromeCookiesApiAvailable(): boolean {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.cookies?.get === 'function'
  } catch {
    return false
  }
}

/** `Set-Cookie` is not readable from fetch in extension contexts; poll `chrome.cookies` after `/begin`. */
export async function readSidCookieWithRetry(
  baseUrl: string,
  attempts = 8,
  delayMs = 40
): Promise<string | undefined> {
  if (!chromeCookiesApiAvailable()) return undefined
  for (let i = 0; i < attempts; i++) {
    const sid = await readSidCookie(baseUrl)
    if (sid) return sid
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)))
    }
  }
  return undefined
}

export async function setLatchSidCookie(baseUrl: string, sid: string): Promise<void> {
  try {
    await chrome.cookies.set({
      url: sessionCookieUrl(baseUrl),
      name: 'sid',
      value: sid,
      path: '/',
      secure: true,
      sameSite: 'no_restriction',
    })
  } catch {
    // ignore
  }
}

export async function clearLatchSidCookie(baseUrl: string): Promise<void> {
  const url = sessionCookieUrl(baseUrl)
  try {
    const cookies = await chrome.cookies.getAll({ url, name: 'sid' })
    await Promise.all(
      cookies.map((cookie) =>
        chrome.cookies.remove({
          url,
          name: 'sid',
          ...(cookie.storeId ? { storeId: cookie.storeId } : {}),
        })
      )
    )
  } catch {
    try {
      await chrome.cookies.remove({ url, name: 'sid' })
    } catch {
      // ignore
    }
  }
}

export async function persistWebauthnCeremony(
  kind: WebauthnSessionKind,
  opts: { sid?: string; challenge?: string }
): Promise<void> {
  const baseUrl = latchApiBaseUrl()
  const chromeExtensionId = chrome.runtime?.id
  if (!chromeExtensionId || (!opts.sid && !opts.challenge)) return

  const session: WebauthnSession = {
    sid: opts.sid ?? '',
    baseUrl,
    chromeExtensionId,
    startedAtMs: Date.now(),
    kind,
    ...(opts.challenge ? { challenge: opts.challenge } : {}),
  }
  try {
    await chrome.storage.session.set({ [WEBAUTHN_SESSION_KEY]: session })
  } catch {
    // ignore
  }
}

export async function persistWebauthnSessionSid(
  sid: string,
  kind: WebauthnSessionKind,
  challenge?: string
): Promise<void> {
  const baseUrl = latchApiBaseUrl()
  const chromeExtensionId = chrome.runtime?.id
  if (!chromeExtensionId) return

  const session: WebauthnSession = {
    sid,
    baseUrl,
    chromeExtensionId,
    startedAtMs: Date.now(),
    kind,
    ...(challenge ? { challenge } : {}),
  }
  try {
    await chrome.storage.session.set({ [WEBAUTHN_SESSION_KEY]: session })
  } catch {
    // ignore
  }
}

/** Persist API `sid` after `/begin` so `/finish` can attach it if `credentials: include` drops it. */
export async function persistWebauthnSession(
  kind: WebauthnSessionKind,
  sidFromResponse?: string
): Promise<void> {
  const baseUrl = latchApiBaseUrl()
  const sid = sidFromResponse ?? (await readSidCookieWithRetry(baseUrl))
  if (!sid) return
  await persistWebauthnSessionSid(sid, kind)
}

export async function getWebauthnSession(
  expectedKind: WebauthnSessionKind
): Promise<WebauthnSession | undefined> {
  const baseUrl = latchApiBaseUrl()
  try {
    const bag = await chrome.storage.session.get(WEBAUTHN_SESSION_KEY)
    const session = bag[WEBAUTHN_SESSION_KEY] as WebauthnSession | undefined
    if (
      session &&
      session.baseUrl === baseUrl &&
      session.kind === expectedKind &&
      Date.now() - session.startedAtMs < 300_000 &&
      (session.sid || session.challenge)
    ) {
      return session
    }
  } catch {
    // ignore
  }
  return undefined
}

/** Persist `sid` from a Set-Cookie response (begin or authentication finish rotation). */
export async function captureSid(baseUrl: string, res: Response): Promise<string | undefined> {
  let sid = extractSidFromFetchResponse(res)
  if (sid) {
    await setLatchSidCookie(baseUrl, sid)
    return sid
  }
  sid = await readSidCookieWithRetry(baseUrl, 12, 50)
  return sid
}

/** @deprecated Prefer {@link captureSid} — same behavior. */
export const captureSidAfterBegin = captureSid

export async function webauthnSessionCookieHeader(
  expectedKind: WebauthnSessionKind
): Promise<Record<string, string>> {
  const baseUrl = latchApiBaseUrl()
  const session = await getWebauthnSession(expectedKind)
  if (session?.sid) return { Cookie: `sid=${session.sid}` }
  const sid = await readSidCookie(baseUrl)
  if (sid) return { Cookie: `sid=${sid}` }
  return {}
}

export async function clearWebauthnSession(): Promise<void> {
  try {
    await chrome.storage.session.remove(WEBAUTHN_SESSION_KEY)
  } catch {
    // ignore
  }
}

/**
 * Drop the Latch API session entirely (`sid` cookie + any in-flight ceremony).
 *
 * The API identifies callers by an anonymous `sid` cookie and mints a new user
 * when it is absent, so a stale cookie makes a fresh install look like the
 * previous session user and its whole account list. Call this on logout and
 * whenever local storage holds no accounts.
 */
export async function clearLatchApiSession(): Promise<void> {
  await clearWebauthnSession()
  await clearLatchSidCookie(latchApiBaseUrl())
}
