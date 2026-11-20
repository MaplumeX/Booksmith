import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM encryption for per-user LLM API keys stored in Postgres.
 * Master key must come from `AGENT_SECRET_KEY`; never fall back to a hardcoded secret
 * or auto-generated local file that would break stateless container backups.
 * See ADR 2026-11-20-builtin-epub-agent.
 */

const VERSION_PREFIX = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const HEX_64 = /^[0-9a-fA-F]{64}$/

export class AgentSecretNotConfiguredError extends Error {
  readonly code = 'agent_secret_not_configured'
  constructor() {
    super('AGENT_SECRET_KEY is not configured on the server')
    this.name = 'AgentSecretNotConfiguredError'
  }
}

export class InvalidAgentSecretKeyError extends Error {
  readonly code = 'invalid_agent_secret_key'
  constructor(message = 'AGENT_SECRET_KEY must be 32 bytes encoded as 64 hex chars or base64/base64url') {
    super(message)
    this.name = 'InvalidAgentSecretKeyError'
  }
}

export class AgentKeyDecryptError extends Error {
  readonly code = 'agent_key_decrypt_failed'
  constructor(message = 'Failed to decrypt stored API key; verify AGENT_SECRET_KEY matches') {
    super(message)
    this.name = 'AgentKeyDecryptError'
  }
}

/**
 * Parses a 32-byte master key from hex (64 chars) or base64/base64url.
 * Returns null when unset so editing continues to work without Agent secrets configured.
 */
export function parseAgentSecretKey(raw: string | undefined): Buffer | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null

  if (HEX_64.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }

  // Accept standard base64 or base64url when it decodes cleanly to exactly 32 bytes.
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(normalized, 'base64')
    if (decoded.byteLength === KEY_BYTES) return decoded
  }

  throw new InvalidAgentSecretKeyError()
}

export interface EncryptedApiKey {
  ciphertext: string | null
  last4: string | null
}

export function encryptApiKey(plaintext: string | undefined | null, key: Buffer | null): EncryptedApiKey {
  const trimmed = plaintext?.trim() ?? ''
  if (!trimmed) return { ciphertext: null, last4: null }
  if (!key) throw new AgentSecretNotConfiguredError()

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  const ciphertext = [
    VERSION_PREFIX,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':')

  const last4 = trimmed.length >= 8 ? trimmed.slice(-4) : '••••'
  return { ciphertext, last4 }
}

export function decryptApiKey(ciphertext: string | null | undefined, key: Buffer | null): string | null {
  if (!ciphertext) return null
  if (!key) throw new AgentSecretNotConfiguredError()

  const parts = ciphertext.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    throw new AgentKeyDecryptError('Unsupported encrypted API key format')
  }

  try {
    const iv = Buffer.from(parts[1]!, 'base64url')
    const authTag = Buffer.from(parts[2]!, 'base64url')
    const payload = Buffer.from(parts[3]!, 'base64url')
    if (iv.byteLength !== IV_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
      throw new AgentKeyDecryptError('Corrupted encrypted API key parameters')
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
  } catch (error) {
    if (error instanceof AgentKeyDecryptError) throw error
    throw new AgentKeyDecryptError()
  }
}
