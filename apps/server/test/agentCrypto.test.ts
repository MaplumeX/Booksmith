import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentKeyDecryptError,
  AgentSecretNotConfiguredError,
  InvalidAgentSecretKeyError,
  decryptApiKey,
  encryptApiKey,
  parseAgentSecretKey,
} from '../src/agent/crypto'
import { loadConfig } from '../src/config'
import { createDb } from '../src/db/client'
import { agentMessages, agentProfiles, agentThreads, books, users } from '../src/db/schema'
import { TEST_URL } from './global-setup'

describe('agent API key encryption', () => {
  const hexKey = randomBytes(32).toString('hex')
  const b64Key = randomBytes(32).toString('base64')
  const b64UrlKey = randomBytes(32).toString('base64url')

  it('parses unset, hex, base64, and base64url keys and rejects malformed values', () => {
    expect(parseAgentSecretKey(undefined)).toBeNull()
    expect(parseAgentSecretKey('   ')).toBeNull()
    expect(parseAgentSecretKey(hexKey)?.byteLength).toBe(32)
    expect(parseAgentSecretKey(b64Key)?.byteLength).toBe(32)
    expect(parseAgentSecretKey(b64UrlKey)?.byteLength).toBe(32)
    expect(() => parseAgentSecretKey('too-short')).toThrow(InvalidAgentSecretKeyError)
    expect(() => parseAgentSecretKey('zz'.repeat(32))).toThrow(InvalidAgentSecretKeyError)
  })

  it('roundtrips API keys with AES-256-GCM, uses random IVs, and masks last4', () => {
    const key = parseAgentSecretKey(hexKey)!
    const secret = 'sk-ant-api03-very-secret-key-9876'

    const first = encryptApiKey(secret, key)
    const second = encryptApiKey(secret, key)

    expect(first.ciphertext).not.toBeNull()
    expect(first.ciphertext).not.toContain(secret)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.last4).toBe('9876')
    expect(decryptApiKey(first.ciphertext, key)).toBe(secret)

    // Short keys do not leak trailing characters verbatim.
    const shortSecret = encryptApiKey('abc12', key)
    expect(shortSecret.last4).toBe('••••')
    expect(decryptApiKey(shortSecret.ciphertext, key)).toBe('abc12')
  })

  it('allows keyless local endpoints without AGENT_SECRET_KEY but blocks non-empty keys', () => {
    expect(encryptApiKey('', null)).toEqual({ ciphertext: null, last4: null })
    expect(encryptApiKey('   ', null)).toEqual({ ciphertext: null, last4: null })
    expect(decryptApiKey(null, null)).toBeNull()

    expect(() => encryptApiKey('sk-live-12345678', null)).toThrow(AgentSecretNotConfiguredError)

    const key = parseAgentSecretKey(hexKey)!
    const { ciphertext } = encryptApiKey('sk-live-12345678', key)
    expect(() => decryptApiKey(ciphertext, null)).toThrow(AgentSecretNotConfiguredError)
  })

  it('rejects tampered ciphertexts or wrong master keys', () => {
    const keyA = parseAgentSecretKey(hexKey)!
    const keyB = parseAgentSecretKey(b64Key)!
    const { ciphertext } = encryptApiKey('sk-test-abcdef12', keyA)

    expect(() => decryptApiKey(ciphertext, keyB)).toThrow(AgentKeyDecryptError)
    expect(() => decryptApiKey(`${ciphertext}x`, keyA)).toThrow(AgentKeyDecryptError)
    expect(() => decryptApiKey('v2:bad', keyA)).toThrow(AgentKeyDecryptError)
  })

  it('loads config cleanly when AGENT_SECRET_KEY is absent', () => {
    const cfg = loadConfig({ DATABASE_URL: TEST_URL })
    expect(cfg.agentSecretKey).toBeNull()
    const cfgWithKey = loadConfig({ DATABASE_URL: TEST_URL, AGENT_SECRET_KEY: hexKey })
    expect(cfgWithKey.agentSecretKey?.byteLength).toBe(32)
  })
})

describe('agent Postgres tables & FK constraints', () => {
  let store: ReturnType<typeof createDb>

  beforeAll(() => {
    store = createDb(TEST_URL)
  })

  afterAll(async () => {
    await store.sql.end()
  })

  it('persists profiles, threads, and messages and enforces SET NULL / CASCADE', async () => {
    const email = `agent-schema-${Date.now()}@booksmith.test`
    const [user] = await store.db
      .insert(users)
      .values({ email, passwordHash: 'hash' })
      .returning()

    const [book] = await store.db
      .insert(books)
      .values({
        ownerId: user!.id,
        title: 'Schema Test Book',
        byteSize: 128,
        sha256: '0'.repeat(64),
      })
      .returning()

    const key = parseAgentSecretKey(randomBytes(32).toString('hex'))!
    const encrypted = encryptApiKey('sk-schema-test-5678', key)

    const [profile] = await store.db
      .insert(agentProfiles)
      .values({
        userId: user!.id,
        name: 'Claude Sonnet',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-20250514',
        apiKeyCiphertext: encrypted.ciphertext,
        apiKeyLast4: encrypted.last4,
        isDefault: true,
      })
      .returning()

    const [thread] = await store.db
      .insert(agentThreads)
      .values({
        bookId: book!.id,
        userId: user!.id,
        title: '第一章校对',
        profileId: profile!.id,
      })
      .returning()

    await store.db.insert(agentMessages).values({
      threadId: thread!.id,
      role: 'user',
      content: '帮我检查错别字',
    })

    // Deleting a profile nulls thread.profileId without losing conversation history.
    await store.db.delete(agentProfiles).where(eq(agentProfiles.id, profile!.id))
    const [afterProfileDelete] = await store.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, thread!.id))
    expect(afterProfileDelete?.profileId).toBeNull()

    // Deleting the book cascades to threads and messages.
    await store.db.delete(books).where(eq(books.id, book!.id))
    const remainingThreads = await store.db
      .select()
      .from(agentThreads)
      .where(eq(agentThreads.id, thread!.id))
    const remainingMessages = await store.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.threadId, thread!.id))
    expect(remainingThreads).toHaveLength(0)
    expect(remainingMessages).toHaveLength(0)

    await store.db.delete(users).where(eq(users.id, user!.id))
  })
})
