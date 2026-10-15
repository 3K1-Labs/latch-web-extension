import { randomBytes } from '@noble/hashes/utils.js'

const VAULT_SUFFIX = 'mnemonicVault.v1'

async function vaultStorageKey(): Promise<string> {
  const res = await chrome.storage.local.get(['latch.developerMode'])
  const env = res['latch.developerMode'] === true ? 'dev' : 'prod'
  return `latch.env.${env}.${VAULT_SUFFIX}`
}

export type MnemonicVaultPayloadV1 = {
  v: 1
  accountId: string
  saltB64: string
  ivB64: string
  ciphertextB64: string
  pbkdf2Iters: number
}

const PBKDF2_ITERS = 210_000
const SALT_LEN = 16
const IV_LEN = 12

function encodeB64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!)
  return btoa(s)
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  )
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptMnemonicForVault(args: {
  accountId: string
  mnemonic: string
  bip39Passphrase: string
  encryptionPassword: string
}): Promise<MnemonicVaultPayloadV1> {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const aesKey = await deriveAesKey(args.encryptionPassword, salt)
  const enc = new TextEncoder()
  const plain = enc.encode(
    JSON.stringify({
      mnemonic: args.mnemonic,
      bip39Passphrase: args.bip39Passphrase,
    })
  )
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain)
  )
  plain.fill(0)
  return {
    v: 1,
    accountId: args.accountId,
    saltB64: encodeB64(salt),
    ivB64: encodeB64(iv),
    ciphertextB64: encodeB64(ciphertext),
    pbkdf2Iters: PBKDF2_ITERS,
  }
}

export async function decryptMnemonicFromVault(
  payload: MnemonicVaultPayloadV1,
  encryptionPassword: string
): Promise<{ mnemonic: string; bip39Passphrase: string }> {
  const salt = decodeB64(payload.saltB64)
  const iv = decodeB64(payload.ivB64)
  const ciphertext = decodeB64(payload.ciphertextB64)
  const aesKey = await deriveAesKey(encryptionPassword, salt)
  let plain: Uint8Array
  try {
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)
    plain = new Uint8Array(buf)
  } catch {
    throw new Error('Incorrect password or corrupted vault.')
  }
  const json = new TextDecoder().decode(plain)
  plain.fill(0)
  const parsed = JSON.parse(json) as { mnemonic?: string; bip39Passphrase?: string }
  if (typeof parsed.mnemonic !== 'string') throw new Error('Invalid vault payload.')
  return {
    mnemonic: parsed.mnemonic,
    bip39Passphrase: typeof parsed.bip39Passphrase === 'string' ? parsed.bip39Passphrase : '',
  }
}

export async function saveMnemonicVaultRecord(record: MnemonicVaultPayloadV1): Promise<void> {
  const key = await vaultStorageKey()
  const res = await chrome.storage.local.get([key])
  const prev = (res[key] as MnemonicVaultPayloadV1[] | undefined) ?? []
  const next = [...prev.filter((r) => r.accountId !== record.accountId), record]
  await chrome.storage.local.set({ [key]: next })
}

export async function loadMnemonicVaultRecord(
  accountId: string
): Promise<MnemonicVaultPayloadV1 | undefined> {
  const key = await vaultStorageKey()
  const res = await chrome.storage.local.get([key])
  const list = (res[key] as MnemonicVaultPayloadV1[] | undefined) ?? []
  return list.find((r) => r.accountId === accountId)
}

export async function removeMnemonicVaultForAccount(accountId: string): Promise<void> {
  const key = await vaultStorageKey()
  const res = await chrome.storage.local.get([key])
  const list = (res[key] as MnemonicVaultPayloadV1[] | undefined) ?? []
  const next = list.filter((r) => r.accountId !== accountId)
  await chrome.storage.local.set({ [key]: next })
}

export async function clearAllMnemonicVaultRecords(): Promise<void> {
  await chrome.storage.local.remove([await vaultStorageKey()])
}
