import { and, asc, desc, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AgentProposal, EpubArchive } from '@booksmith/core'
import {
  AgentKeyDecryptError,
  AgentSecretNotConfiguredError,
  decryptApiKey,
  encryptApiKey,
} from '../agent/crypto'
import {
  InvalidProviderConfigError,
  isAgentProvider,
  testProfileConnection,
  validateBaseUrl,
  type AgentProviderType,
} from '../agent/providers'
import { runAgentTurn, type AgentStreamEvent, type ToolCallSummary } from '../agent/runner'
import type { Config } from '../config'
import type { Db } from '../db/client'
import {
  agentMessages,
  agentProfiles,
  agentThreads,
  books,
  type AgentMessage,
  type AgentProfile,
  type AgentThread,
  type Book,
  type User,
} from '../db/schema'
import type { FileStore } from '../storage/fileStore'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface AgentDeps {
  db: Db
  config: Config
  fileStore: FileStore
}

export interface AgentProfileDto {
  id: string
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKeyLast4: string | null
  isDefault: boolean
  updatedAt: string
}

export interface AgentThreadDto {
  id: string
  bookId: string
  title: string
  profileId: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentMessageDto {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  content: string
  context: { activePath?: string | null; selection?: string | null } | null
  toolCalls: ToolCallSummary[]
  proposal: AgentProposal | null
  proposalStatus: 'pending' | 'applied' | 'dismissed' | null
  error: string | null
  createdAt: string
}

function toProfileDto(row: AgentProfile): AgentProfileDto {
  return {
    id: row.id,
    name: row.name,
    provider: isAgentProvider(row.provider) ? row.provider : 'openai-compatible',
    baseUrl: row.baseUrl,
    model: row.model,
    hasApiKey: Boolean(row.apiKeyCiphertext),
    apiKeyLast4: row.apiKeyLast4,
    isDefault: row.isDefault,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toThreadDto(row: AgentThread): AgentThreadDto {
  return {
    id: row.id,
    bookId: row.bookId,
    title: row.title,
    profileId: row.profileId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toMessageDto(row: AgentMessage): AgentMessageDto {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    context: safeJsonParse(row.contextJson, null),
    toolCalls: safeJsonParse<ToolCallSummary[]>(row.toolCallsJson, []),
    proposal: safeJsonParse<AgentProposal | null>(row.proposalJson, null),
    proposalStatus:
      row.proposalStatus === 'pending' || row.proposalStatus === 'applied' || row.proposalStatus === 'dismissed'
        ? row.proposalStatus
        : null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }
}

function requireUser(request: FastifyRequest, reply: FastifyReply): User | null {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'unauthenticated' })
    return null
  }
  return request.currentUser
}

async function findOwnedBook(db: Db, id: string | undefined, ownerId: string): Promise<Book | null> {
  if (!id || !UUID.test(id)) return null
  const rows = await db
    .select()
    .from(books)
    .where(and(eq(books.id, id), eq(books.ownerId, ownerId)))
    .limit(1)
  return rows[0] ?? null
}

async function findOwnedProfile(db: Db, id: string | undefined, userId: string): Promise<AgentProfile | null> {
  if (!id || !UUID.test(id)) return null
  const rows = await db
    .select()
    .from(agentProfiles)
    .where(and(eq(agentProfiles.id, id), eq(agentProfiles.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

async function findOwnedThread(
  db: Db,
  bookId: string,
  threadId: string | undefined,
  userId: string,
): Promise<AgentThread | null> {
  if (!threadId || !UUID.test(threadId)) return null
  const rows = await db
    .select()
    .from(agentThreads)
    .where(and(eq(agentThreads.id, threadId), eq(agentThreads.bookId, bookId), eq(agentThreads.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

function autoTitleFromPrompt(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim()
  if (!singleLine) return '新对话'
  return singleLine.length > 24 ? `${singleLine.slice(0, 24)}…` : singleLine
}

function sendCryptoOrValidationError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentSecretNotConfiguredError) {
    return reply.code(503).send({
      error: error.code,
      message: '服务端未配置 AGENT_SECRET_KEY，暂无法加密保存或读取 API Key，请联系管理员配置环境变量。',
    })
  }
  if (error instanceof AgentKeyDecryptError) {
    return reply.code(500).send({
      error: error.code,
      message: '无法解密已保存的 API Key，请确认服务端 AGENT_SECRET_KEY 未变更，或重新填写密钥。',
    })
  }
  if (error instanceof InvalidProviderConfigError) {
    return reply.code(400).send({ error: error.code, message: error.message })
  }
  throw error
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentDeps): void {
  const { db, config, fileStore } = deps
  const secretKey = config.agentSecretKey ?? null

  // --- Model profiles ---

  app.get('/api/agent/profiles', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const rows = await db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.userId, user.id))
      .orderBy(desc(agentProfiles.isDefault), desc(agentProfiles.updatedAt))

    return reply.send({
      secretConfigured: Boolean(secretKey),
      profiles: rows.map(toProfileDto),
    })
  })

  app.post('/api/agent/profiles', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const body = (request.body ?? {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const provider = body.provider
    const rawBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const rawApiKey = typeof body.apiKey === 'string' ? body.apiKey : ''

    if (!name) return reply.code(400).send({ error: 'invalid_profile', message: '预设名称不能为空' })
    if (!isAgentProvider(provider)) {
      return reply.code(400).send({ error: 'invalid_profile', message: '协议仅支持 openai-compatible 或 anthropic' })
    }
    if (!model) return reply.code(400).send({ error: 'invalid_profile', message: '模型名称不能为空' })

    let baseUrl: string
    let encrypted: { ciphertext: string | null; last4: string | null }
    try {
      baseUrl = validateBaseUrl(rawBaseUrl)
      encrypted = encryptApiKey(rawApiKey, secretKey)
    } catch (error) {
      return sendCryptoOrValidationError(reply, error)
    }

    const existing = await db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(eq(agentProfiles.userId, user.id))
      .limit(1)
    const shouldBeDefault = body.isDefault === true || existing.length === 0

    if (shouldBeDefault) {
      await db.update(agentProfiles).set({ isDefault: false }).where(eq(agentProfiles.userId, user.id))
    }

    const [created] = await db
      .insert(agentProfiles)
      .values({
        userId: user.id,
        name,
        provider,
        baseUrl,
        model,
        apiKeyCiphertext: encrypted.ciphertext,
        apiKeyLast4: encrypted.last4,
        isDefault: shouldBeDefault,
      })
      .returning()

    return reply.code(201).send({ profile: toProfileDto(created!) })
  })

  app.patch<{ Params: { profileId: string } }>('/api/agent/profiles/:profileId', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const existing = await findOwnedProfile(db, request.params.profileId, user.id)
    if (!existing) return reply.code(404).send({ error: 'not_found' })

    const body = (request.body ?? {}) as Record<string, unknown>
    const updates: Partial<typeof agentProfiles.$inferInsert> = { updatedAt: new Date() }

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return reply.code(400).send({ error: 'invalid_profile', message: '预设名称不能为空' })
      updates.name = name
    }

    if (body.provider !== undefined) {
      if (!isAgentProvider(body.provider)) {
        return reply.code(400).send({ error: 'invalid_profile', message: '协议仅支持 openai-compatible 或 anthropic' })
      }
      updates.provider = body.provider
    }

    if (body.baseUrl !== undefined) {
      try {
        updates.baseUrl = validateBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '')
      } catch (error) {
        return sendCryptoOrValidationError(reply, error)
      }
    }

    if (body.model !== undefined) {
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!model) return reply.code(400).send({ error: 'invalid_profile', message: '模型名称不能为空' })
      updates.model = model
    }

    if (body.clearApiKey === true) {
      updates.apiKeyCiphertext = null
      updates.apiKeyLast4 = null
    } else if (typeof body.apiKey === 'string' && body.apiKey.trim().length > 0) {
      try {
        const encrypted = encryptApiKey(body.apiKey, secretKey)
        updates.apiKeyCiphertext = encrypted.ciphertext
        updates.apiKeyLast4 = encrypted.last4
      } catch (error) {
        return sendCryptoOrValidationError(reply, error)
      }
    }

    if (body.isDefault === true) {
      await db.update(agentProfiles).set({ isDefault: false }).where(eq(agentProfiles.userId, user.id))
      updates.isDefault = true
    }

    const [updated] = await db
      .update(agentProfiles)
      .set(updates)
      .where(eq(agentProfiles.id, existing.id))
      .returning()

    return reply.send({ profile: toProfileDto(updated!) })
  })

  app.delete<{ Params: { profileId: string } }>('/api/agent/profiles/:profileId', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const existing = await findOwnedProfile(db, request.params.profileId, user.id)
    if (!existing) return reply.code(404).send({ error: 'not_found' })

    await db.delete(agentProfiles).where(eq(agentProfiles.id, existing.id))

    if (existing.isDefault) {
      const [replacement] = await db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.userId, user.id))
        .orderBy(desc(agentProfiles.updatedAt))
        .limit(1)
      if (replacement) {
        await db.update(agentProfiles).set({ isDefault: true }).where(eq(agentProfiles.id, replacement.id))
      }
    }

    return reply.code(204).send()
  })

  app.post('/api/agent/profiles/test', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const body = (request.body ?? {}) as Record<string, unknown>
    const provider = body.provider
    const rawBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const profileId = typeof body.profileId === 'string' ? body.profileId : undefined
    let apiKey: string | null = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : null

    if (!isAgentProvider(provider)) {
      return reply.code(400).send({ error: 'invalid_profile', message: '协议仅支持 openai-compatible 或 anthropic' })
    }
    if (!model) return reply.code(400).send({ error: 'invalid_profile', message: '模型名称不能为空' })

    let baseUrl: string
    try {
      baseUrl = validateBaseUrl(rawBaseUrl)
      if (!apiKey && profileId) {
        const stored = await findOwnedProfile(db, profileId, user.id)
        if (!stored) return reply.code(404).send({ error: 'not_found' })
        apiKey = decryptApiKey(stored.apiKeyCiphertext, secretKey)
      }
    } catch (error) {
      return sendCryptoOrValidationError(reply, error)
    }

    const result = await testProfileConnection({ provider, baseUrl, model, apiKey })
    return reply.send(result)
  })

  // --- Per-book threads ---

  app.get<{ Params: { id: string } }>('/api/books/:id/agent/threads', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    const book = await findOwnedBook(db, request.params.id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const rows = await db
      .select()
      .from(agentThreads)
      .where(and(eq(agentThreads.bookId, book.id), eq(agentThreads.userId, user.id)))
      .orderBy(desc(agentThreads.updatedAt))

    return reply.send({ threads: rows.map(toThreadDto) })
  })

  app.post<{ Params: { id: string } }>('/api/books/:id/agent/threads', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    const book = await findOwnedBook(db, request.params.id, user.id)
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const body = (request.body ?? {}) as Record<string, unknown>
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 80) : '新对话'
    let profileId: string | null = null

    if (typeof body.profileId === 'string' && body.profileId.trim()) {
      const profile = await findOwnedProfile(db, body.profileId.trim(), user.id)
      if (!profile) return reply.code(404).send({ error: 'profile_not_found' })
      profileId = profile.id
    } else {
      const [defaultProfile] = await db
        .select({ id: agentProfiles.id })
        .from(agentProfiles)
        .where(and(eq(agentProfiles.userId, user.id), eq(agentProfiles.isDefault, true)))
        .limit(1)
      profileId = defaultProfile?.id ?? null
    }

    const [created] = await db
      .insert(agentThreads)
      .values({ bookId: book.id, userId: user.id, title, profileId })
      .returning()

    return reply.code(201).send({ thread: toThreadDto(created!) })
  })

  app.get<{ Params: { id: string; threadId: string } }>(
    '/api/books/:id/agent/threads/:threadId',
    async (request, reply) => {
      const user = requireUser(request, reply)
      if (!user) return
      const book = await findOwnedBook(db, request.params.id, user.id)
      if (!book) return reply.code(404).send({ error: 'not_found' })
      const thread = await findOwnedThread(db, book.id, request.params.threadId, user.id)
      if (!thread) return reply.code(404).send({ error: 'not_found' })

      const messages = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.threadId, thread.id))
        .orderBy(asc(agentMessages.createdAt))

      return reply.send({
        thread: toThreadDto(thread),
        messages: messages.map(toMessageDto),
      })
    },
  )

  app.patch<{ Params: { id: string; threadId: string } }>(
    '/api/books/:id/agent/threads/:threadId',
    async (request, reply) => {
      const user = requireUser(request, reply)
      if (!user) return
      const book = await findOwnedBook(db, request.params.id, user.id)
      if (!book) return reply.code(404).send({ error: 'not_found' })
      const thread = await findOwnedThread(db, book.id, request.params.threadId, user.id)
      if (!thread) return reply.code(404).send({ error: 'not_found' })

      const body = (request.body ?? {}) as Record<string, unknown>
      const updates: Partial<typeof agentThreads.$inferInsert> = { updatedAt: new Date() }

      if (body.title !== undefined) {
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : ''
        if (!title) return reply.code(400).send({ error: 'invalid_title', message: '会话标题不能为空' })
        updates.title = title
      }

      if (body.profileId !== undefined) {
        if (body.profileId === null || body.profileId === '') {
          updates.profileId = null
        } else if (typeof body.profileId === 'string') {
          const profile = await findOwnedProfile(db, body.profileId, user.id)
          if (!profile) return reply.code(404).send({ error: 'profile_not_found' })
          updates.profileId = profile.id
        }
      }

      const [updated] = await db
        .update(agentThreads)
        .set(updates)
        .where(eq(agentThreads.id, thread.id))
        .returning()

      return reply.send({ thread: toThreadDto(updated!) })
    },
  )

  app.delete<{ Params: { id: string; threadId: string } }>(
    '/api/books/:id/agent/threads/:threadId',
    async (request, reply) => {
      const user = requireUser(request, reply)
      if (!user) return
      const book = await findOwnedBook(db, request.params.id, user.id)
      if (!book) return reply.code(404).send({ error: 'not_found' })
      const thread = await findOwnedThread(db, book.id, request.params.threadId, user.id)
      if (!thread) return reply.code(404).send({ error: 'not_found' })

      await db.delete(agentThreads).where(eq(agentThreads.id, thread.id))
      return reply.code(204).send()
    },
  )

  // --- Streaming turn execution (SSE) ---

  app.post<{ Params: { id: string; threadId: string } }>(
    '/api/books/:id/agent/threads/:threadId/messages',
    async (request, reply) => {
      const user = requireUser(request, reply)
      if (!user) return
      const book = await findOwnedBook(db, request.params.id, user.id)
      if (!book) return reply.code(404).send({ error: 'not_found' })
      const thread = await findOwnedThread(db, book.id, request.params.threadId, user.id)
      if (!thread) return reply.code(404).send({ error: 'not_found' })

      const body = (request.body ?? {}) as Record<string, unknown>
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      if (!content) return reply.code(400).send({ error: 'empty_message', message: '请输入消息内容' })

      const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : Number(body.baseVersion)
      if (!Number.isInteger(baseVersion) || baseVersion <= 0) {
        return reply.code(400).send({ error: 'invalid_version', message: '缺少有效的书籍版本号' })
      }
      if (baseVersion !== book.currentVersion) {
        return reply.code(409).send({
          error: 'version_conflict',
          currentVersion: book.currentVersion,
          message: '书籍已在其他位置更新，请先重新加载后再继续对话。',
        })
      }

      // Resolve profile: explicit request.profileId -> thread.profileId -> user's default profile
      let profile: AgentProfile | null = null
      if (typeof body.profileId === 'string' && body.profileId.trim()) {
        profile = await findOwnedProfile(db, body.profileId.trim(), user.id)
        if (!profile) return reply.code(404).send({ error: 'profile_not_found' })
      } else if (thread.profileId) {
        profile = await findOwnedProfile(db, thread.profileId, user.id)
      }
      if (!profile) {
        const [fallback] = await db
          .select()
          .from(agentProfiles)
          .where(eq(agentProfiles.userId, user.id))
          .orderBy(desc(agentProfiles.isDefault), desc(agentProfiles.updatedAt))
          .limit(1)
        profile = fallback ?? null
      }
      if (!profile) {
        return reply.code(400).send({
          error: 'no_agent_profile',
          message: '还没有配置模型预设，请先在右上角或助手设置中添加一个模型预设。',
        })
      }

      let apiKey: string | null
      try {
        apiKey = decryptApiKey(profile.apiKeyCiphertext, secretKey)
      } catch (error) {
        return sendCryptoOrValidationError(reply, error)
      }

      // Build AgentWorkspace directly from unpacked `book_entries` (text + mimetype bytes only,
      // zero binary bytea detoasting or zip unpacking). See ADR 2026-11-20-entry-level-book-storage.
      const workspaceRows = await fileStore.listWorkspaceEntries(book.id)
      if (workspaceRows.length === 0) return reply.code(404).send({ error: 'not_found' })
      const emptyBinary = new Uint8Array(0)
      const archive: EpubArchive = {
        order: workspaceRows.map((row) => row.path),
        entries: new Map(
          workspaceRows.map((row) => [row.path, row.bytes ? new Uint8Array(row.bytes) : emptyBinary]),
        ),
      }

      const dirtyTexts: Record<string, string> = {}
      if (body.dirtyTexts && typeof body.dirtyTexts === 'object') {
        for (const [k, v] of Object.entries(body.dirtyTexts as Record<string, unknown>)) {
          if (typeof v === 'string') dirtyTexts[k] = v
        }
      }
      const deletedPaths = Array.isArray(body.deletedPaths)
        ? body.deletedPaths.filter((item): item is string => typeof item === 'string')
        : []

      const rawContext = body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : null
      const context = rawContext
        ? {
            activePath: typeof rawContext.activePath === 'string' ? rawContext.activePath : null,
            selection: typeof rawContext.selection === 'string' ? rawContext.selection : null,
          }
        : undefined

      const priorMessages = await db
        .select({ role: agentMessages.role, content: agentMessages.content })
        .from(agentMessages)
        .where(eq(agentMessages.threadId, thread.id))
        .orderBy(asc(agentMessages.createdAt))

      const history = priorMessages.map((row) => ({
        role: (row.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: row.content,
      }))

      await db.insert(agentMessages).values({
        threadId: thread.id,
        role: 'user',
        content,
        contextJson: context ? JSON.stringify(context) : null,
      })

      const nextTitle =
        priorMessages.length === 0 && thread.title === '新对话' ? autoTitleFromPrompt(content) : thread.title
      await db
        .update(agentThreads)
        .set({ title: nextTitle, profileId: profile.id, updatedAt: new Date() })
        .where(eq(agentThreads.id, thread.id))

      // Hijack Fastify response to stream SSE directly with reverse-proxy buffering disabled.
      // See ADR 2026-11-20-builtin-epub-agent.
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      raw.flushHeaders?.()

      const controller = new AbortController()
      request.raw.on('close', () => {
        if (!raw.writableEnded) controller.abort()
      })

      const writeEvent = (payload: Record<string, unknown>) => {
        if (raw.writableEnded) return
        raw.write(`data: ${JSON.stringify(payload)}\n\n`)
      }

      const result = await runAgentTurn({
        archive,
        overlay: { dirtyTexts, deletedPaths },
        provider: {
          provider: isAgentProvider(profile.provider) ? profile.provider : 'openai-compatible',
          baseUrl: profile.baseUrl,
          model: profile.model,
          apiKey,
        },
        history,
        userMessage: content,
        context,
        abortSignal: controller.signal,
        onEvent: (event: AgentStreamEvent) => {
          // Hold `done` until the assistant message is persisted so the client gets its real messageId.
          if (event.type === 'done') return
          writeEvent(event)
        },
      })

      const [savedAssistant] = await db
        .insert(agentMessages)
        .values({
          threadId: thread.id,
          role: 'assistant',
          content: result.content,
          toolCallsJson: result.toolCalls.length > 0 ? JSON.stringify(result.toolCalls) : null,
          proposalJson: result.proposal ? JSON.stringify(result.proposal) : null,
          proposalStatus: result.proposal ? 'pending' : null,
          error: result.error ? result.error.message : null,
        })
        .returning()

      await db.update(agentThreads).set({ updatedAt: new Date() }).where(eq(agentThreads.id, thread.id))

      writeEvent({
        type: 'done',
        messageId: savedAssistant?.id,
        threadTitle: nextTitle,
        stopped: result.stopped,
      })
      if (!raw.writableEnded) raw.end()
    },
  )

  // --- Proposal status update ---

  app.patch<{ Params: { id: string; messageId: string } }>(
    '/api/books/:id/agent/proposals/:messageId',
    async (request, reply) => {
      const user = requireUser(request, reply)
      if (!user) return
      const book = await findOwnedBook(db, request.params.id, user.id)
      if (!book) return reply.code(404).send({ error: 'not_found' })

      const { messageId } = request.params
      if (!UUID.test(messageId)) return reply.code(404).send({ error: 'not_found' })

      const body = (request.body ?? {}) as Record<string, unknown>
      if (body.status !== 'applied' && body.status !== 'dismissed') {
        return reply.code(400).send({ error: 'invalid_status', message: '状态只能是 applied 或 dismissed' })
      }

      const rows = await db
        .select({ message: agentMessages })
        .from(agentMessages)
        .innerJoin(agentThreads, eq(agentThreads.id, agentMessages.threadId))
        .where(
          and(
            eq(agentMessages.id, messageId),
            eq(agentThreads.bookId, book.id),
            eq(agentThreads.userId, user.id),
          ),
        )
        .limit(1)

      const found = rows[0]?.message
      if (!found) return reply.code(404).send({ error: 'not_found' })
      if (!found.proposalJson) {
        return reply.code(400).send({ error: 'no_proposal', message: '该消息不包含变更提案' })
      }

      const [updated] = await db
        .update(agentMessages)
        .set({ proposalStatus: body.status })
        .where(eq(agentMessages.id, found.id))
        .returning()

      return reply.send({ message: toMessageDto(updated!) })
    },
  )
}
