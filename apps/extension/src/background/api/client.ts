import type { SerializableError } from '@latch/types'

import { latchApiBaseUrl, latchRequestTimeoutMs, noteLatchApiSuccess } from './config'
import { parseApiError } from './errors'

export class BackendError extends Error {
  public readonly status?: number
  public readonly code?: string
  public readonly details?: unknown

  constructor(message: string, opts?: { status?: number; code?: string; details?: unknown }) {
    super(message)
    this.name = 'BackendError'
    this.status = opts?.status
    this.code = opts?.code
    this.details = opts?.details
  }

  toSerializable(): SerializableError {
    return { message: this.message, status: this.status, code: this.code }
  }
}

async function parseJsonResponse(
  res: Response,
  baseUrl: string,
  pathOrUrl: string
): Promise<unknown> {
  const text = await res.text()
  if (!text) return undefined

  const trimmed = text.trimStart()
  if (trimmed.startsWith('<')) {
    throw new BackendError(
      `API returned HTML instead of JSON (${res.status}). Check PLASMO_PUBLIC_LATCH_API_URL (${baseUrl}) and that ${pathOrUrl} exists on your Latch API.`,
      { status: res.status }
    )
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BackendError(
      `API response was not valid JSON (${res.status}). Check PLASMO_PUBLIC_LATCH_API_URL (${baseUrl}) and route ${pathOrUrl}.`,
      { status: res.status }
    )
  }
}

function throwIfNotOk(res: Response, data: unknown): void {
  if (res.ok) return
  const { message, code } = parseApiError(res.status, data)
  throw new BackendError(message, {
    status: res.status,
    code,
    details: data,
  })
}

function mergeAbortSignals(
  timeoutMs: number,
  callerSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void; callerSignal?: AbortSignal } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onCallerAbort = () => ctrl.abort()
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort()
    else callerSignal.addEventListener('abort', onCallerAbort)
  }
  return {
    signal: ctrl.signal,
    callerSignal,
    cleanup: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

export async function latchFetchAbsoluteWithResponse<TRes>(
  url: string,
  init?: RequestInit & { timeoutMs?: number; signal?: AbortSignal }
): Promise<{ res: Response; data: TRes }> {
  const timeoutMs = await latchRequestTimeoutMs(init?.timeoutMs, 20_000)
  const { signal, cleanup, callerSignal } = mergeAbortSignals(timeoutMs, init?.signal)
  const baseUrl = new URL(url).origin

  try {
    if (signal.aborted) {
      if (callerSignal?.aborted) {
        throw new BackendError('Request cancelled', { code: 'cancelled' })
      }
      throw new BackendError('Request timed out', { code: 'timeout' })
    }
    const res = await fetch(url, {
      ...init,
      credentials: init?.credentials ?? 'include',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

    const data = (await parseJsonResponse(res, baseUrl, url)) as TRes
    throwIfNotOk(res, data)
    await noteLatchApiSuccess()
    return { res, data }
  } catch (err) {
    if (err instanceof BackendError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      if (callerSignal?.aborted) {
        throw new BackendError('Request cancelled', { code: 'cancelled' })
      }
      throw new BackendError('Request timed out', { code: 'timeout' })
    }
    throw new BackendError(err instanceof Error ? err.message : String(err))
  } finally {
    cleanup()
  }
}

export async function latchFetchAbsolute<TRes>(
  url: string,
  init?: RequestInit & { timeoutMs?: number; signal?: AbortSignal }
): Promise<TRes> {
  const { data } = await latchFetchAbsoluteWithResponse<TRes>(url, init)
  return data
}

export async function latchFetch<TRes>(
  path: string,
  init?: RequestInit & { timeoutMs?: number; signal?: AbortSignal }
): Promise<TRes> {
  const baseUrl = await latchApiBaseUrl()
  const timeoutMs = await latchRequestTimeoutMs(init?.timeoutMs, 20_000)
  return latchFetchAbsolute<TRes>(`${baseUrl}${path}`, { ...init, timeoutMs })
}
