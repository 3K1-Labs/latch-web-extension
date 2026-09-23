/**
 * Runtime validation for webpage / content-script dapp payloads.
 *
 * TypeScript `as` casts are compile-time only. These parsers fail closed on
 * malformed, oversized, or extra-field input before permissions, storage,
 * backend, or signing.
 */

import { StrKey } from '@stellar/stellar-sdk'
import type {
  DappDisconnectRequest,
  DappOpenSignRequestPayload,
  DappPageSessionStartRequest,
  DappPollRequestResultRequest,
  DappSignTransactionRequest,
  ExternalSignRequest,
  GetDappPermissionsRequest,
  MessageType,
  Network,
  SignTransactionRequest,
} from '@latch/types'

import { isAllowedCallbackUrl } from '../background/externalSign/callbackUrl'
import type { ContentScriptMessageType } from './publicDappProtocol'

/** Approximate max JSON size for a public dapp payload (~300KB). */
export const MAX_PUBLIC_DAPP_PAYLOAD_CHARS = 300_000

/** Max length for unsigned tx XDR (base64) strings (~256KB). */
export const MAX_XDR_CHARS = 256_000

/** Max length for payloadRef / requestId tokens. */
export const MAX_TOKEN_CHARS = 128

/** Max length for callback URLs. */
export const MAX_CALLBACK_URL_CHARS = 2048

const TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/

export type DappValidationError = { message: string; code: 'validation_error' }

export function dappValidationError(message: string): DappValidationError {
  return { message, code: 'validation_error' }
}

export class PublicDappPayloadError extends Error {
  readonly code = 'validation_error' as const
  constructor(message: string) {
    super(message)
    this.name = 'PublicDappPayloadError'
  }
}

function fail(message: string): never {
  throw new PublicDappPayloadError(message)
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      fail(`${label} has unexpected field: ${key}`)
    }
  }
}

function assertPayloadSize(payload: unknown): void {
  try {
    const encoded = JSON.stringify(payload ?? null)
    if (encoded !== undefined && encoded.length > MAX_PUBLIC_DAPP_PAYLOAD_CHARS) {
      fail('Payload exceeds maximum size')
    }
  } catch {
    fail('Payload is not JSON-serializable')
  }
}

export function parseNetwork(value: unknown, label = 'network'): Network {
  if (value !== 'testnet' && value !== 'mainnet') {
    fail(`${label} must be testnet or mainnet`)
  }
  return value
}

export function parseSmartAccountAddress(value: unknown, label = 'account'): string {
  if (typeof value !== 'string') {
    fail(`${label} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed || !StrKey.isValidContract(trimmed)) {
    fail(`${label} must be a valid Stellar contract address`)
  }
  return trimmed
}

export function parseXdrString(value: unknown, label = 'xdr'): string {
  if (typeof value !== 'string') {
    fail(`${label} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    fail(`${label} must be non-empty`)
  }
  if (trimmed.length > MAX_XDR_CHARS) {
    fail(`${label} exceeds maximum size`)
  }
  if (!BASE64_PATTERN.test(trimmed)) {
    fail(`${label} must be base64-encoded`)
  }
  return trimmed
}

export function parseToken(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    fail(`${label} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    fail(`${label} must be non-empty`)
  }
  if (trimmed.length > MAX_TOKEN_CHARS) {
    fail(`${label} exceeds maximum length`)
  }
  if (!TOKEN_PATTERN.test(trimmed)) {
    fail(`${label} contains invalid characters`)
  }
  return trimmed
}

export function parseCallbackUrl(value: unknown, label = 'callback'): string {
  if (typeof value !== 'string') {
    fail(`${label} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    fail(`${label} must be non-empty`)
  }
  if (trimmed.length > MAX_CALLBACK_URL_CHARS) {
    fail(`${label} exceeds maximum length`)
  }
  if (!isAllowedCallbackUrl(trimmed)) {
    fail('Callback URL must be https:// or http://localhost')
  }
  return trimmed
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    fail(`${label} must be a boolean`)
  }
  return value
}

function parseOptionalOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    fail('origin must be a string')
  }
  const trimmed = value.trim()
  if (!trimmed) {
    fail('origin must be non-empty')
  }
  return trimmed
}

function parseRequiredOrigin(obj: Record<string, unknown>): string {
  const origin = parseOptionalOrigin(obj.origin)
  if (!origin) {
    fail('origin is required')
  }
  return origin
}

/** Empty or origin-only payloads for ping / getNetwork. */
export function parseEmptyOrOriginPayload(payload: unknown): { origin?: string } {
  assertPayloadSize(payload)
  if (payload === undefined || payload === null) {
    return {}
  }
  const obj = assertPlainObject(payload, 'Payload')
  assertExactKeys(obj, ['origin'], 'Payload')
  const origin = parseOptionalOrigin(obj.origin)
  return origin ? { origin } : {}
}

export function parseOriginOnlyPayload(payload: unknown): GetDappPermissionsRequest {
  assertPayloadSize(payload)
  const obj = assertPlainObject(payload, 'Payload')
  assertExactKeys(obj, ['origin'], 'Payload')
  return { origin: parseRequiredOrigin(obj) }
}

export function parseDappPollRequestResultPayload(payload: unknown): DappPollRequestResultRequest {
  assertPayloadSize(payload)
  const obj = assertPlainObject(payload, 'Payload')
  assertExactKeys(obj, ['origin', 'requestId'], 'Payload')
  return {
    origin: parseRequiredOrigin(obj),
    requestId: parseToken(obj.requestId, 'requestId'),
  }
}

export function parseSignTransactionRequest(value: unknown): SignTransactionRequest {
  const obj = assertPlainObject(value, 'request')
  assertExactKeys(obj, ['xdr', 'network', 'accountToSign', 'submit'], 'request')
  for (const key of ['xdr', 'network', 'accountToSign'] as const) {
    if (!(key in obj) || obj[key] === undefined) {
      fail(`request.${key} is required`)
    }
  }
  const submit = parseOptionalBoolean(obj.submit, 'request.submit')
  const request: SignTransactionRequest = {
    xdr: parseXdrString(obj.xdr, 'request.xdr'),
    network: parseNetwork(obj.network, 'request.network'),
    accountToSign: parseSmartAccountAddress(obj.accountToSign, 'request.accountToSign'),
  }
  if (submit !== undefined) request.submit = submit
  return request
}

export function parseDappSignTransactionPayload(payload: unknown): DappSignTransactionRequest {
  assertPayloadSize(payload)
  const obj = assertPlainObject(payload, 'Payload')
  assertExactKeys(obj, ['origin', 'request'], 'Payload')
  if (!('request' in obj) || obj.request === undefined) {
    fail('request is required')
  }
  return {
    origin: parseRequiredOrigin(obj),
    request: parseSignTransactionRequest(obj.request),
  }
}

/**
 * ExternalSignRequest nested under openSignRequest.
 * Requires callback + requestId; exactly one of unsignedTxXdr | payloadRef.
 */
export function parseExternalSignRequest(value: unknown): ExternalSignRequest {
  const obj = assertPlainObject(value, 'request')
  assertExactKeys(
    obj,
    [
      'network',
      'smartAccountAddress',
      'unsignedTxXdr',
      'payloadRef',
      'callback',
      'requestId',
      'submit',
      'origin',
    ],
    'request'
  )

  for (const key of ['network', 'smartAccountAddress', 'callback', 'requestId'] as const) {
    if (!(key in obj) || obj[key] === undefined) {
      fail(`request.${key} is required`)
    }
  }

  const hasXdr = obj.unsignedTxXdr !== undefined && obj.unsignedTxXdr !== null
  const hasRef = obj.payloadRef !== undefined && obj.payloadRef !== null
  if (hasXdr === hasRef) {
    fail('Provide exactly one of unsignedTxXdr or payloadRef')
  }

  const submit = parseOptionalBoolean(obj.submit, 'request.submit')
  const origin = parseOptionalOrigin(obj.origin)

  const request: ExternalSignRequest = {
    network: parseNetwork(obj.network, 'request.network'),
    smartAccountAddress: parseSmartAccountAddress(
      obj.smartAccountAddress,
      'request.smartAccountAddress'
    ),
    callback: parseCallbackUrl(obj.callback, 'request.callback'),
    requestId: parseToken(obj.requestId, 'request.requestId'),
  }

  if (hasXdr) {
    request.unsignedTxXdr = parseXdrString(obj.unsignedTxXdr, 'request.unsignedTxXdr')
  }
  if (hasRef) {
    request.payloadRef = parseToken(obj.payloadRef, 'request.payloadRef')
  }
  if (submit !== undefined) request.submit = submit
  if (origin !== undefined) request.origin = origin

  return request
}

export function parseDappOpenSignRequestPayload(payload: unknown): DappOpenSignRequestPayload {
  assertPayloadSize(payload)
  const obj = assertPlainObject(payload, 'Payload')
  assertExactKeys(obj, ['origin', 'request'], 'Payload')
  if (!('request' in obj) || obj.request === undefined) {
    fail('request is required')
  }
  return {
    origin: parseRequiredOrigin(obj),
    request: parseExternalSignRequest(obj.request),
  }
}

export type ParsedPublicDappPayload =
  | { origin?: string }
  | GetDappPermissionsRequest
  | DappDisconnectRequest
  | DappPageSessionStartRequest
  | DappSignTransactionRequest
  | DappOpenSignRequestPayload
  | DappPollRequestResultRequest

/**
 * Parse a content-script-allowed message payload. Throws PublicDappPayloadError
 * on invalid input.
 */
export function parsePublicDappPayload(
  type: ContentScriptMessageType | MessageType,
  payload: unknown
): ParsedPublicDappPayload {
  switch (type) {
    case 'PING_EXTENSION':
    case 'GET_ACTIVE_NETWORK':
      return parseEmptyOrOriginPayload(payload)
    case 'DAPP_GET_PUBLIC_KEY':
    case 'DAPP_DISCONNECT':
    case 'DAPP_PAGE_SESSION_START':
      return parseOriginOnlyPayload(payload)
    case 'DAPP_SIGN_TRANSACTION':
      return parseDappSignTransactionPayload(payload)
    case 'DAPP_OPEN_SIGN_REQUEST':
      return parseDappOpenSignRequestPayload(payload)
    case 'DAPP_POLL_REQUEST_RESULT':
      return parseDappPollRequestResultPayload(payload)
    default:
      fail(`Unsupported public dapp message type: ${String(type)}`)
  }
}

/**
 * Safe parse that returns either the typed payload or a stable validation error
 * object (never throws).
 */
export function tryParsePublicDappPayload(
  type: ContentScriptMessageType | MessageType,
  payload: unknown
): { ok: true; payload: ParsedPublicDappPayload } | { ok: false; error: DappValidationError } {
  try {
    return { ok: true, payload: parsePublicDappPayload(type, payload) }
  } catch (e) {
    const message =
      e instanceof PublicDappPayloadError
        ? e.message
        : e instanceof Error
          ? e.message
          : 'Invalid dapp payload'
    return { ok: false, error: dappValidationError(message) }
  }
}
