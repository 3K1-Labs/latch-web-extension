import type { ExternalSignRequest, Network } from '@latch/types'

import { assertAllowedCallbackUrl } from './callbackUrl'
import {
  MAX_CALLBACK_URL_CHARS,
  MAX_TOKEN_CHARS,
  MAX_XDR_CHARS,
  parseCallbackUrl,
  parseSmartAccountAddress,
  parseToken,
  parseXdrString,
  PublicDappPayloadError,
} from '../../dapp/publicDappPayload'

function parseSubmitFlag(raw: string | null): boolean {
  if (raw === null || raw === '') return true
  const v = raw.toLowerCase()
  return v !== 'false' && v !== '0'
}

function parseNetwork(raw: string | null): Network {
  if (raw === 'mainnet') return 'mainnet'
  if (raw === 'testnet') return 'testnet'
  throw new Error('Invalid network: expected testnet or mainnet')
}

export function fromBase64Url(b64url: string): string {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  return b64
}

export function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function buildSignRequestSearchParams(request: ExternalSignRequest): string {
  const params = new URLSearchParams()
  params.set('network', request.network)
  params.set('account', request.smartAccountAddress)
  if (request.unsignedTxXdr) {
    params.set('xdr', toBase64Url(request.unsignedTxXdr))
  }
  if (request.payloadRef) params.set('payloadRef', request.payloadRef)
  if (request.callback) params.set('callback', request.callback)
  if (request.requestId) params.set('requestId', request.requestId)
  if (request.submit !== undefined) params.set('submit', String(request.submit))
  if (request.origin) params.set('origin', request.origin)
  return params.toString()
}

function validationMessage(e: unknown, fallback: string): string {
  if (e instanceof PublicDappPayloadError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

/** Parse sign-request tab query params into ExternalSignRequest. */
export function parseSignRequestFromSearchParams(search: string): ExternalSignRequest {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const network = parseNetwork(params.get('network'))

  let smartAccountAddress: string
  try {
    smartAccountAddress = parseSmartAccountAddress(params.get('account'), 'account')
  } catch (e) {
    throw new Error(validationMessage(e, 'Missing account parameter'))
  }

  const rawXdr = params.get('xdr')?.trim()
  const rawPayloadRef = params.get('payloadRef')?.trim()
  if (!rawXdr && !rawPayloadRef) throw new Error('Either xdr or payloadRef is required')
  if (rawXdr && rawPayloadRef) throw new Error('Provide only one of xdr or payloadRef')

  let xdr: string | undefined
  if (rawXdr) {
    if (rawXdr.length > MAX_XDR_CHARS) {
      throw new Error('xdr exceeds maximum size')
    }
    const decoded = fromBase64Url(rawXdr)
    try {
      xdr = parseXdrString(decoded, 'xdr')
    } catch (e) {
      throw new Error(validationMessage(e, 'Invalid xdr'))
    }
  }

  let payloadRef: string | undefined
  if (rawPayloadRef) {
    try {
      payloadRef = parseToken(rawPayloadRef, 'payloadRef')
    } catch (e) {
      throw new Error(validationMessage(e, 'Invalid payloadRef'))
    }
  }

  const rawCallback = params.get('callback')?.trim()
  if (!rawCallback) throw new Error('Missing callback parameter')
  if (rawCallback.length > MAX_CALLBACK_URL_CHARS) {
    throw new Error('callback exceeds maximum length')
  }
  // Preserve existing assert for clear javascript: rejection message in tests.
  assertAllowedCallbackUrl(rawCallback)
  let callback: string
  try {
    callback = parseCallbackUrl(rawCallback, 'callback')
  } catch (e) {
    throw new Error(validationMessage(e, 'Invalid callback'))
  }

  const rawRequestId = params.get('requestId')?.trim()
  let requestId: string | undefined
  if (rawRequestId) {
    if (rawRequestId.length > MAX_TOKEN_CHARS) {
      throw new Error('requestId exceeds maximum length')
    }
    try {
      requestId = parseToken(rawRequestId, 'requestId')
    } catch (e) {
      throw new Error(validationMessage(e, 'Invalid requestId'))
    }
  }

  const origin = params.get('origin')?.trim() || undefined
  const submit = parseSubmitFlag(params.get('submit'))

  return {
    network,
    smartAccountAddress,
    unsignedTxXdr: xdr,
    payloadRef,
    callback,
    requestId,
    origin,
    submit,
  }
}
