import { and, asc, desc, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AgentProposal, EpubArchive } from '@booksmith/core'
import {
  normalizeContextWindow,
  normalizeModelContextWindows,
  resolveContextWindow,
} from '../agent/contextWindow'
import {
  AgentKeyDecryptError,
  AgentSecretNotConfiguredError,
  decryptApiKey,
  encryptApiKey,
} from '../agent/crypto'
import {
  fetchProviderModels,
  InvalidProviderConfigError,
  isAgentProvider,
  testProfileConnection,
  validateBaseUrl,
  type AgentProviderType,
} from '../agent/providers'
import {
  isAgentApprovalMode,
  MAX_TOOL_STEPS,
  normalizeMaxToolSteps,
  runAgentTurn,
  toTimelineItems,
  type AgentApprovalMode,
  type AgentProposalStatus,
  type AgentStepRecord,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type CompactionNotice,
  type HistoryTurn,
  type PendingProposalSeed,
  type ProposalResolution,
  type ToolCallSummary,
} from '../agent/runner'
import { MAX_CUSTOM_INSTRUCTIONS_CHARS, type AgentTurnContext } from '../agent/systemPrompt'
import type { Config } from '../config'
import type { Db } from '../db/client'
import {
  agentMessages,
  agentProfiles,
  agentThreads,
  agentUserSettings,
  books,
  type AgentMessage,
  type AgentProfile,
  type AgentThread,
  type AgentUserSetting,
  type Book,
  type User,
} from '../db/schema'
import type { FileStore } from '../storage/fileStore'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PROFILE_MODELS = 100
const DEFAULT_SSE_HEARTBEAT_MS = 2_000

interface AgentDeps {
  db: Db
  config: Config
  fileStore: FileStore
  sseHeartbeatMs?: number
}

export interface AgentProfileDto {
  id: string
  name: string
  provider: AgentProviderType
  baseUrl: string
  model: string
  models: string[]
  contextWindow: number | null
  modelContextWindows: Record<string, number>
  hasApiKey: boolean
  apiKeyLast4: string | null
  isDefault: boolean
  updatedAt: string
}

export interface AgentUserSettingsDto {
  defaultApprovalMode: AgentApprovalMode
  maxSteps: number
  customInstructions: string
  updatedAt: string | null
}

export interface AgentThreadDto {
  id: string
  bookId: string
  title: string
  profileId: string | null
  model: string | null
  approvalMode: AgentApprovalMode
  compactionSummary: string | null
  compactedUpToMessageId: string | null
  lastInputTokens: number | null
  lastContextWindow: number | null
  createdAt: string
  updatedAt: string
}

export interface AgentMessageDto {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string | null
  context: {
    activePath?: string | null
    selection?: string | null
    selectionStartLine?: number | null
    selectionEndLine?: number | null
  } | null
  timeline: AgentTimelineItem[]
  toolCalls: ToolCallSummary[]
  proposal: AgentProposal | null
  proposalStatus: AgentProposalStatus | null
  proposalResolution: ProposalResolution | null
  compactionNotice: CompactionNotice | null
  error: string | null
  createdAt: string
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Keeps the primary default model in the list, deduplicates, and caps size for legacy & multi-model rows.
 * See ADR 2026-11-20-agent-modes-and-multimodel. */
function normalizeProfileModels(primaryModel: string, rawModels: unknown): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const primary = primaryModel.trim()

  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed) || out.length >= MAX_PROFILE_MODELS) return
    seen.add(trimmed)
    out.push(trimmed)
  }

  if (Array.isArray(rawModels)) {
    for (const item of rawModels) add(item)
  }
  if (primary && !seen.has(primary)) {
    out.unshift(primary)
    if (out.length > MAX_PROFILE_MODELS) out.length = MAX_PROFILE_MODELS
  }
  return out
}

function parseProposalStatus(raw: unknown): AgentProposalStatus | null {
  if (
    raw === 'pending' ||
    raw === 'applied' ||
    raw === 'dismissed' ||
    raw === 'reverted' ||
    raw === 'superseded'
  ) {
    return raw
  }
  return null
}

function parseProposalResolution(raw: unknown): ProposalResolution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const out: ProposalResolution = {}
  if (typeof obj.keptHunks === 'number' && Number.isInteger(obj.keptHunks) && obj.keptHunks >= 0) {
    out.keptHunks = obj.keptHunks
  }
  if (typeof obj.totalHunks === 'number' && Number.isInteger(obj.totalHunks) && obj.totalHunks >= 0) {
    out.totalHunks = obj.totalHunks
  }
  if (Array.isArray(obj.skippedPaths)) {
    const cleaned = obj.skippedPaths
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 50)
    if (cleaned.length > 0) out.skippedPaths = cleaned
  }
  if (typeof obj.summary === 'string' && obj.summary.trim()) {
    out.summary = obj.summary.trim().slice(0, 400)
  }
  return Object.keys(out).length > 0 ? out : null
}

function toProfileDto(row: AgentProfile): AgentProfileDto {
  const parsed = safeJsonParse<unknown>(row.modelsJson, null)
  const modelContextWindows = normalizeModelContextWindows(safeJsonParse<unknown>(row.modelContextWindowsJson, null))
  return {
    id: row.id,
    name: row.name,
    provider: isAgentProvider(row.provider) ? row.provider : 'openai-compatible',
    baseUrl: row.baseUrl,
    model: row.model,
    models: normalizeProfileModels(row.model, parsed),
    contextWindow: normalizeContextWindow(row.contextWindow),
    modelContextWindows,
    hasApiKey: Boolean(row.apiKeyCiphertext),
    apiKeyLast4: row.apiKeyLast4,
    isDefault: row.isDefault,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toSettingsDto(row: AgentUserSetting | null): AgentUserSettingsDto {
  if (!row) {
    return {
      defaultApprovalMode: 'review',
      maxSteps: MAX_TOOL_STEPS,
      customInstructions: '',
      updatedAt: null,
    }
  }
  return {
    defaultApprovalMode: isAgentApprovalMode(row.defaultApprovalMode) ? row.defaultApprovalMode : 'review',
    maxSteps: normalizeMaxToolSteps(row.maxSteps),
    customInstructions: row.customInstructions,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toThreadDto(row: AgentThread): AgentThreadDto {
  return {
    id: row.id,
    bookId: row.bookId,
    title: row.title,
    profileId: row.profileId,
    model: row.model,
    approvalMode: isAgentApprovalMode(row.approvalMode) ? row.approvalMode : 'review',
    compactionSummary: row.compactionSummary,
    compactedUpToMessageId: row.compactedUpToMessageId,
    lastInputTokens: row.lastInputTokens,
    lastContextWindow: row.lastContextWindow,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toMessageDto(row: AgentMessage): AgentMessageDto {
  const steps = safeJsonParse<AgentStepRecord[]>(row.stepsJson, [])
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    reasoning: row.reasoning,
    context: safeJsonParse(row.contextJson, null),
    timeline: steps.length > 0 ? toTimelineItems(steps) : [],
    toolCalls: safeJsonParse<ToolCallSummary[]>(row.toolCallsJson, []),
    proposal: safeJsonParse<AgentProposal | null>(row.proposalJson, null),
    proposalStatus: parseProposalStatus(row.proposalStatus),
    proposalResolution: parseProposalResolution(safeJsonParse<unknown>(row.proposalResolutionJson, null)),
    compactionNotice: safeJsonParse<CompactionNotice | null>(row.compactionNoticeJson, null),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }
}

function sliceMessagesAfterCompaction<T extends { id: string }>(
  rows: readonly T[],
  compactedUpToMessageId: string | null,
): T[] {
  if (!compactedUpToMessageId) return [...rows]
  const boundaryIdx = rows.findIndex((row) => row.id === compactedUpToMessageId)
  if (boundaryIdx < 0) return [...rows]
  return rows.slice(boundaryIdx + 1)
}

function rowsToHistoryTurns(rows: readonly AgentMessage[]): HistoryTurn[] {
  return rows.map((row) => {
    const role = (row.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant'
    if (role === 'user') {
      return {
        id: row.id,
        role,
        content: row.content,
        context: safeJsonParse<AgentTurnContext | null>(row.contextJson, null),
      }
    }
    const steps = safeJsonParse<AgentStepRecord[] | null>(row.stepsJson, null)
    const proposal = safeJsonParse<AgentProposal | null>(row.proposalJson, null)
    return {
      id: row.id,
      role,
      content: row.content,
      steps: Array.isArray(steps) && steps.length > 0 ? steps : null,
      proposalStatus: parseProposalStatus(row.proposalStatus),
      proposalResolution: parseProposalResolution(safeJsonParse<unknown>(row.proposalResolutionJson, null)),
      proposalFilePaths: proposal ? proposal.files.map((f) => f.path) : null,
    }
  })
}

function findLatestPendingProposal(rows: readonly AgentMessage[]): PendingProposalSeed | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!
    if (row.role !== 'assistant') continue
    if (row.proposalStatus !== 'pending' || !row.proposalJson) continue
    const proposal = safeJsonParse<AgentProposal | null>(row.proposalJson, null)
    if (proposal && Array.isArray(proposal.files) && proposal.files.length > 0) {
      return { messageId: row.id, proposal }
    }
  }
  return null
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

async function loadUserSettings(db: Db, userId: string): Promise<AgentUserSettingsDto> {
  const rows = await db
    .select()
    .from(agentUserSettings)
    .where(eq(agentUserSettings.userId, userId))
    .limit(1)
  return toSettingsDto(rows[0] ?? null)
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

function parseOverlay(body: Record<string, unknown>): {
  dirtyTexts: Record<string, string>
  deletedPaths: string[]
} {
  const dirtyTexts: Record<string, string> = {}
  if (body.dirtyTexts && typeof body.dirtyTexts === 'object') {
    for (const [k, v] of Object.entries(body.dirtyTexts as Record<string, unknown>)) {
      if (typeof v === 'string') dirtyTexts[k] = v
    }
  }
  const deletedPaths = Array.isArray(body.deletedPaths)
    ? body.deletedPaths.filter((item): item is string => typeof item === 'string')
    : []
  return { dirtyTexts, deletedPaths }
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentDeps): void {
  const { db, config, fileStore } = deps
  const secretKey = config.agentSecretKey ?? null
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS
  const activeTurns = new Map<string, AbortController>()

  app.addHook('onClose', async () => {
    for (const controller of activeTurns.values()) {
      controller.abort()
    }
    activeTurns.clear()
  })

  // --- Cloud-synced per-user Agent preferences ---

  app.get('/api/agent/settings', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return
    const settings = await loadUserSettings(db, user.id)
    return reply.send({ settings })
  })

  app.patch('/api/agent/settings', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const body = (request.body ?? {}) as Record<string, unknown>
    const current = await loadUserSettings(db, user.id)

    let defaultApprovalMode = current.defaultApprovalMode
    if (body.defaultApprovalMode !== undefined) {
      if (!isAgentApprovalMode(body.defaultApprovalMode)) {
        return reply.code(400).send({
          error: 'invalid_approval_mode',
          message: '默认审批模式仅支持 ask、review 或 auto',
        })
      }
      defaultApprovalMode = body.defaultApprovalMode
    }

    let maxSteps = current.maxSteps
    if (body.maxSteps !== undefined) {
      if (body.maxSteps === null || body.maxSteps === '') {
        maxSteps = 0
      } else {
        const parsed = typeof body.maxSteps === 'number' ? body.maxSteps : Number(body.maxSteps)
        if (!Number.isInteger(parsed) || parsed < 0) {
          return reply.code(400).send({
            error: 'invalid_max_steps',
            message: '单轮最大工具步数必须为非负整数（0 或留空表示不限制）',
          })
        }
        maxSteps = parsed
      }
    }

    let customInstructions = current.customInstructions
    if (body.customInstructions !== undefined) {
      if (typeof body.customInstructions !== 'string') {
        return reply.code(400).send({ error: 'invalid_custom_instructions', message: '自定义附加指令必须为文本' })
      }
      if (body.customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
        return reply.code(400).send({
          error: 'invalid_custom_instructions',
          message: `自定义附加指令不能超过 ${MAX_CUSTOM_INSTRUCTIONS_CHARS} 字`,
        })
      }
      customInstructions = body.customInstructions
    }

    const now = new Date()
    const [saved] = await db
      .insert(agentUserSettings)
      .values({
        userId: user.id,
        defaultApprovalMode,
        maxSteps,
        customInstructions,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentUserSettings.userId,
        set: {
          defaultApprovalMode,
          maxSteps,
          customInstructions,
          updatedAt: now,
        },
      })
      .returning()

    return reply.send({ settings: toSettingsDto(saved ?? null) })
  })

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
    const rawModels = Array.isArray(body.models) ? body.models : undefined
    const explicitModel = typeof body.model === 'string' ? body.model.trim() : ''
    const normalizedModels = normalizeProfileModels(explicitModel, rawModels)
    const model = explicitModel || normalizedModels[0] || ''
    const rawApiKey = typeof body.apiKey === 'string' ? body.apiKey : ''

    if (!name) return reply.code(400).send({ error: 'invalid_profile', message: '预设名称不能为空' })
    if (!isAgentProvider(provider)) {
      return reply.code(400).send({ error: 'invalid_profile', message: '协议仅支持 openai-compatible 或 anthropic' })
    }
    if (!model) return reply.code(400).send({ error: 'invalid_profile', message: '至少需要填写一个模型名称' })

    const finalModels = normalizeProfileModels(model, normalizedModels)
    let contextWindow: number | null = null
    if (body.contextWindow !== undefined && body.contextWindow !== null && body.contextWindow !== '') {
      contextWindow = normalizeContextWindow(body.contextWindow)
      if (contextWindow === null) {
        return reply.code(400).send({
          error: 'invalid_context_window',
          message: '上下文窗口需为 2048–10000000 之间的正整数（留空表示自动识别）',
        })
      }
    }
    const modelContextWindows = normalizeModelContextWindows(body.modelContextWindows)

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
        modelsJson: JSON.stringify(finalModels),
        contextWindow,
        modelContextWindowsJson: Object.keys(modelContextWindows).length > 0 ? JSON.stringify(modelContextWindows) : null,
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

    const existingModels = normalizeProfileModels(existing.model, safeJsonParse<unknown>(existing.modelsJson, null))
    if (body.models !== undefined || body.model !== undefined) {
      let nextModel = existing.model
      if (body.model !== undefined) {
        const candidate = typeof body.model === 'string' ? body.model.trim() : ''
        if (!candidate) return reply.code(400).send({ error: 'invalid_profile', message: '模型名称不能为空' })
        nextModel = candidate
      }

      if (body.models !== undefined) {
        if (!Array.isArray(body.models)) {
          return reply.code(400).send({ error: 'invalid_profile', message: '模型列表格式无效' })
        }
        const cleanedList = body.models
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
        if (cleanedList.length === 0 && body.model === undefined) {
          return reply.code(400).send({ error: 'invalid_profile', message: '至少需要保留一个模型' })
        }
        if (body.model === undefined && cleanedList.length > 0 && !cleanedList.includes(nextModel)) {
          nextModel = cleanedList[0]!
        }
        const normalized = normalizeProfileModels(nextModel, cleanedList)
        updates.model = nextModel
        updates.modelsJson = JSON.stringify(normalized)
      } else {
        // Legacy single-model PATCH: replace default model while keeping additional configured models intact.
        const merged = normalizeProfileModels(
          nextModel,
          existingModels.map((m) => (m === existing.model ? nextModel : m)),
        )
        updates.model = nextModel
        updates.modelsJson = JSON.stringify(merged)
      }
    }

    if (body.contextWindow !== undefined) {
      if (body.contextWindow === null || body.contextWindow === '') {
        updates.contextWindow = null
      } else {
        const parsedCtx = normalizeContextWindow(body.contextWindow)
        if (parsedCtx === null) {
          return reply.code(400).send({
            error: 'invalid_context_window',
            message: '上下文窗口需为 2048–10000000 之间的正整数（留空表示自动识别）',
          })
        }
        updates.contextWindow = parsedCtx
      }
    }

    if (body.modelContextWindows !== undefined) {
      const normalizedMap = normalizeModelContextWindows(body.modelContextWindows)
      updates.modelContextWindowsJson =
        Object.keys(normalizedMap).length > 0 ? JSON.stringify(normalizedMap) : null
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

  app.post('/api/agent/profiles/models', async (request, reply) => {
    const user = requireUser(request, reply)
    if (!user) return

    const body = (request.body ?? {}) as Record<string, unknown>
    const provider = body.provider
    const rawBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
    const profileId = typeof body.profileId === 'string' ? body.profileId : undefined
    let apiKey: string | null = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : null

    if (!isAgentProvider(provider)) {
      return reply.code(400).send({ error: 'invalid_profile', message: '协议仅支持 openai-compatible 或 anthropic' })
    }

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

    const result = await fetchProviderModels({ provider, baseUrl, apiKey })
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
    let model: string | null = null

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

    if (typeof body.model === 'string' && body.model.trim()) {
      model = body.model.trim()
    }

    let approvalMode: AgentApprovalMode
    if (body.approvalMode !== undefined) {
      if (!isAgentApprovalMode(body.approvalMode)) {
        return reply.code(400).send({
          error: 'invalid_approval_mode',
          message: '审批模式仅支持 ask、review 或 auto',
        })
      }
      approvalMode = body.approvalMode
    } else {
      const settings = await loadUserSettings(db, user.id)
      approvalMode = settings.defaultApprovalMode
    }

    const [created] = await db
      .insert(agentThreads)
      .values({ bookId: book.id, userId: user.id, title, profileId, model, approvalMode })
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
        .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))

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

      if (body.model !== undefined) {
        if (body.model === null || body.model === '') {
          updates.model = null
        } else if (typeof body.model === 'string') {
          updates.model = body.model.trim() || null
        }
      }

      if (body.approvalMode !== undefined) {
        if (!isAgentApprovalMode(body.approvalMode)) {
          return reply.code(400).send({
            error: 'invalid_approval_mode',
            message: '审批模式仅支持 ask、review 或 auto',
          })
        }
        updates.approvalMode = body.approvalMode
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

      const active = activeTurns.get(thread.id)
      if (active) {
        active.abort()
        activeTurns.delete(thread.id)
      }

      await db.delete(agentThreads).where(eq(agentThreads.id, thread.id))
      return reply.code(204).send()
    },
  )

  app.post<{ Params: { id: string; threadId: string } }>(
    '/api/books/:id/agent/threads/:threadId/abort',
    async (request, reply) => {
      const user = requireUser(request, reply)
      if (!user) return
      const book = await findOwnedBook(db, request.params.id, user.id)
      if (!book) return reply.code(404).send({ error: 'not_found' })
      const thread = await findOwnedThread(db, book.id, request.params.threadId, user.id)
      if (!thread) return reply.code(404).send({ error: 'not_found' })

      const active = activeTurns.get(thread.id)
      if (!active) return reply.send({ aborted: false })
      active.abort()
      return reply.send({ aborted: true })
    },
  )

  // --- Shared turn execution & streaming helper ---

  async function resolveTurnExecution(options: {
    request: FastifyRequest
    reply: FastifyReply
    user: User
    book: Book
    thread: AgentThread
    body: Record<string, unknown>
    userMessage: string
    context: AgentTurnContext | undefined
    history: HistoryTurn[]
    pendingProposalSeed: PendingProposalSeed | null
    nextTitle: string
    persistUserMessage: boolean
    replaceMessageId?: string
  }): Promise<void> {
    const {
      request,
      reply,
      user,
      book,
      thread,
      body,
      userMessage,
      context,
      history,
      pendingProposalSeed,
      nextTitle,
      persistUserMessage,
      replaceMessageId,
    } = options

    const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : Number(body.baseVersion)
    if (!Number.isInteger(baseVersion) || baseVersion <= 0) {
      reply.code(400).send({ error: 'invalid_version', message: '缺少有效的书籍版本号' })
      return
    }
    if (baseVersion !== book.currentVersion) {
      reply.code(409).send({
        error: 'version_conflict',
        currentVersion: book.currentVersion,
        message: '书籍已在其他位置更新，请先重新加载后再继续对话。',
      })
      return
    }

    let approvalMode: AgentApprovalMode = isAgentApprovalMode(thread.approvalMode) ? thread.approvalMode : 'review'
    if (body.approvalMode !== undefined) {
      if (!isAgentApprovalMode(body.approvalMode)) {
        reply.code(400).send({
          error: 'invalid_approval_mode',
          message: '审批模式仅支持 ask、review 或 auto',
        })
        return
      }
      approvalMode = body.approvalMode
    }

    // Resolve profile: explicit request.profileId -> thread.profileId -> user's default profile
    let profile: AgentProfile | null = null
    if (typeof body.profileId === 'string' && body.profileId.trim()) {
      profile = await findOwnedProfile(db, body.profileId.trim(), user.id)
      if (!profile) {
        reply.code(404).send({ error: 'profile_not_found' })
        return
      }
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
      reply.code(400).send({
        error: 'no_agent_profile',
        message: '还没有配置模型预设，请先在右上角或助手设置中添加一个模型预设。',
      })
      return
    }

    const explicitModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null
    const inheritedThreadModel = thread.profileId === profile.id ? thread.model : null
    const effectiveModel = explicitModel ?? inheritedThreadModel ?? profile.model

    let apiKey: string | null
    try {
      apiKey = decryptApiKey(profile.apiKeyCiphertext, secretKey)
    } catch (error) {
      sendCryptoOrValidationError(reply, error)
      return
    }

    const controller = new AbortController()
    const abortTurn = () => {
      if (!controller.signal.aborted) controller.abort()
    }
    const raw = reply.raw
    // Listen on `reply.raw` (ServerResponse) rather than `request.raw` (IncomingMessage):
    // Fastify consumes and closes `request.raw` while parsing the POST JSON body before the handler runs,
    // so client disconnects during SSE streaming emit `'close'` on `reply.raw` with `writableEnded === false`.
    const onResponseClose = () => {
      if (!raw.writableEnded) abortTurn()
    }
    const onResponseError = () => {
      abortTurn()
    }
    raw.once('close', onResponseClose)
    raw.on('error', onResponseError)
    if (raw.destroyed || raw.closed) abortTurn()

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null

    try {
      // Cancel any stale in-flight turn on the same thread before registering this one.
      const previous = activeTurns.get(thread.id)
      if (previous && previous !== controller) previous.abort()
      activeTurns.set(thread.id, controller)

      // Build AgentWorkspace directly from unpacked `book_entries` (text + mimetype bytes only,
      // zero binary bytea detoasting or zip unpacking). See ADR 2026-11-20-entry-level-book-storage.
      const workspaceRows = await fileStore.listWorkspaceEntries(book.id)
      if (controller.signal.aborted || raw.destroyed || raw.closed) {
        if (!raw.destroyed && !raw.writableEnded) {
          reply.hijack()
          raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          raw.write(`data: ${JSON.stringify({ type: 'done', stopped: true })}\n\n`)
          raw.end()
        }
        return
      }
      if (workspaceRows.length === 0) {
        reply.code(404).send({ error: 'not_found' })
        return
      }
      const emptyBinary = new Uint8Array(0)
      const archive: EpubArchive = {
        order: workspaceRows.map((row) => row.path),
        entries: new Map(
          workspaceRows.map((row) => [row.path, row.bytes ? new Uint8Array(row.bytes) : emptyBinary]),
        ),
      }
      const overlay = parseOverlay(body)
      const userSettings = await loadUserSettings(db, user.id)
      if (controller.signal.aborted || raw.destroyed || raw.closed) {
        if (!raw.destroyed && !raw.writableEnded) {
          reply.hijack()
          raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          raw.write(`data: ${JSON.stringify({ type: 'done', stopped: true })}\n\n`)
          raw.end()
        }
        return
      }

      if (persistUserMessage) {
        await db.insert(agentMessages).values({
          threadId: thread.id,
          role: 'user',
          content: userMessage,
          contextJson: context ? JSON.stringify(context) : null,
        })
      }

      await db
        .update(agentThreads)
        .set({
          title: nextTitle,
          profileId: profile.id,
          model: effectiveModel,
          approvalMode,
          updatedAt: new Date(),
        })
        .where(eq(agentThreads.id, thread.id))

      // Hijack Fastify response to stream SSE directly with reverse-proxy buffering disabled.
      // See ADR 2026-11-20-builtin-epub-agent.
      reply.hijack()
      if (raw.destroyed || raw.closed) abortTurn()
      if (!raw.destroyed && !raw.writableEnded) {
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        raw.flushHeaders?.()
      }

      const writeEvent = (payload: Record<string, unknown>) => {
        if (raw.writableEnded || raw.destroyed) return
        try {
          raw.write(`data: ${JSON.stringify(payload)}\n\n`)
        } catch {
          abortTurn()
        }
      }

      // Periodic SSE comment heartbeats keep reverse proxies alive during long reasoning pauses
      // and surface half-open TCP disconnects (CLOSE_WAIT) promptly so silent tab closes abort the LLM turn.
      if (sseHeartbeatMs > 0 && !raw.destroyed && !raw.writableEnded) {
        heartbeatTimer = setInterval(() => {
          if (raw.writableEnded || raw.destroyed || controller.signal.aborted) {
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer)
              heartbeatTimer = null
            }
            return
          }
          try {
            raw.write(': ping\n\n')
          } catch {
            abortTurn()
          }
        }, sseHeartbeatMs)
      }

      const profileModelWindows = normalizeModelContextWindows(
        safeJsonParse<unknown>(profile.modelContextWindowsJson, null),
      )
      const resolvedWindow = resolveContextWindow({
        model: effectiveModel,
        profileContextWindow: profile.contextWindow,
        modelContextWindows: profileModelWindows,
      })
      const sameModelAsLastTurn = thread.profileId === profile.id && thread.model === effectiveModel

      const result = await runAgentTurn({
        archive,
        overlay,
        provider: {
          provider: isAgentProvider(profile.provider) ? profile.provider : 'openai-compatible',
          baseUrl: profile.baseUrl,
          model: effectiveModel,
          apiKey,
        },
        history,
        userMessage,
        context,
        approvalMode,
        customInstructions: userSettings.customInstructions,
        contextWindow: resolvedWindow.contextWindow,
        compactionSummary: thread.compactionSummary,
        previousInputTokens: sameModelAsLastTurn ? thread.lastInputTokens : null,
        pendingProposalSeed,
        maxSteps: userSettings.maxSteps,
        abortSignal: controller.signal,
        onEvent: (event: AgentStreamEvent) => {
          // Hold `done` until the assistant message is persisted so the client gets its real messageId.
          if (event.type === 'done') return
          writeEvent(event)
        },
      })

      const hasPartialOutput = Boolean(
        result.content.trim() || result.reasoning.trim() || result.toolCalls.length > 0 || result.proposal,
      )
      const shouldPersistAssistant = !result.stopped || hasPartialOutput

      let savedMessageId: string | undefined
      const supersededMessageId = result.supersededProposalMessageId
      if (shouldPersistAssistant) {
        const persistedFields = {
          content: result.stopped ? result.content || '已停止生成。' : result.content,
          reasoning: result.reasoning.trim() ? result.reasoning : null,
          stepsJson: result.steps.length > 0 ? JSON.stringify(result.steps) : null,
          toolCallsJson: result.toolCalls.length > 0 ? JSON.stringify(result.toolCalls) : null,
          proposalJson: result.proposal ? JSON.stringify(result.proposal) : null,
          proposalStatus: result.proposal ? 'pending' : null,
          proposalResolutionJson: null,
          compactionNoticeJson: result.compaction ? JSON.stringify(result.compaction.notice) : null,
          error: result.error ? result.error.message : null,
        }

        try {
          if (replaceMessageId) {
            const [updated] = await db
              .update(agentMessages)
              .set(persistedFields)
              .where(eq(agentMessages.id, replaceMessageId))
              .returning({ id: agentMessages.id })
            savedMessageId = updated?.id ?? replaceMessageId
          } else {
            const [inserted] = await db
              .insert(agentMessages)
              .values({
                threadId: thread.id,
                role: 'assistant',
                ...persistedFields,
              })
              .returning({ id: agentMessages.id })
            savedMessageId = inserted?.id
          }

          if (supersededMessageId) {
            await db
              .update(agentMessages)
              .set({ proposalStatus: 'superseded' })
              .where(and(eq(agentMessages.id, supersededMessageId), eq(agentMessages.threadId, thread.id)))
          }

          const threadUpdates: Partial<typeof agentThreads.$inferInsert> = {
            updatedAt: new Date(),
            lastInputTokens: result.usage.inputTokens,
            lastContextWindow: result.usage.contextWindow,
          }
          if (
            result.compaction &&
            !result.compaction.notice.degraded &&
            result.compaction.summary &&
            result.compaction.compactedUpToMessageId
          ) {
            threadUpdates.compactionSummary = result.compaction.summary
            threadUpdates.compactedUpToMessageId = result.compaction.compactedUpToMessageId
          }

          await db.update(agentThreads).set(threadUpdates).where(eq(agentThreads.id, thread.id))
        } catch (error) {
          // Ignore FK/missing-row errors if the thread was deleted while an aborted turn was unwinding.
          if (!result.stopped) throw error
        }
      }

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      writeEvent({
        type: 'done',
        messageId: savedMessageId,
        threadTitle: nextTitle,
        stopped: result.stopped,
        approvalMode,
        model: effectiveModel,
        profileId: profile.id,
        usage: result.usage,
        supersededMessageId,
        compactionNotice: result.compaction?.notice ?? null,
      })
      if (!raw.writableEnded && !raw.destroyed) raw.end()
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      raw.off('close', onResponseClose)
      raw.off('error', onResponseError)
      if (activeTurns.get(thread.id) === controller) {
        activeTurns.delete(thread.id)
      }
    }
  }

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

      const rawContext =
        body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : null
      const parsePositiveLine = (value: unknown): number | null =>
        typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
      const context = rawContext
        ? {
            activePath: typeof rawContext.activePath === 'string' ? rawContext.activePath : null,
            selection: typeof rawContext.selection === 'string' ? rawContext.selection : null,
            ...(parsePositiveLine(rawContext.selectionStartLine) !== null
              ? { selectionStartLine: parsePositiveLine(rawContext.selectionStartLine) }
              : {}),
            ...(parsePositiveLine(rawContext.selectionEndLine) !== null
              ? { selectionEndLine: parsePositiveLine(rawContext.selectionEndLine) }
              : {}),
          }
        : undefined

      const priorMessages = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.threadId, thread.id))
        .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))

      // Slice history from the persisted auto-compaction boundary and replay full provider-neutral tool traces
      // plus proposal outcomes so multi-turn sessions stay continuous. See ADR 2026-11-21-agent-session-continuity.
      const activePriorMessages = sliceMessagesAfterCompaction(priorMessages, thread.compactedUpToMessageId)
      const history = rowsToHistoryTurns(activePriorMessages)
      const pendingProposalSeed = findLatestPendingProposal(priorMessages)

      const nextTitle =
        priorMessages.length === 0 && thread.title === '新对话' ? autoTitleFromPrompt(content) : thread.title

      await resolveTurnExecution({
        request,
        reply,
        user,
        book,
        thread,
        body,
        userMessage: content,
        context,
        history,
        pendingProposalSeed,
        nextTitle,
        persistUserMessage: true,
      })
    },
  )

  // --- Retry last assistant turn in place (SSE) ---

  app.post<{ Params: { id: string; threadId: string; messageId: string } }>(
    '/api/books/:id/agent/threads/:threadId/messages/:messageId/retry',
    async (request, reply) => {
      const user = requireUser(request, reply)
      if (!user) return
      const book = await findOwnedBook(db, request.params.id, user.id)
      if (!book) return reply.code(404).send({ error: 'not_found' })
      const thread = await findOwnedThread(db, book.id, request.params.threadId, user.id)
      if (!thread) return reply.code(404).send({ error: 'not_found' })

      const { messageId } = request.params
      if (!UUID.test(messageId)) return reply.code(404).send({ error: 'not_found' })

      const allMessages = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.threadId, thread.id))
        .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))

      const latest = allMessages[allMessages.length - 1]
      if (!latest || latest.id !== messageId || latest.role !== 'assistant') {
        return reply.code(409).send({
          error: 'retry_not_latest',
          message: '仅支持重试当前对话的最后一条助手回复。',
        })
      }

      // Block overwriting an assistant turn whose proposal was already applied so workspace & history stay consistent.
      // See ADR 2026-11-20-agent-modes-and-multimodel.
      if (latest.proposalStatus === 'applied') {
        return reply.code(409).send({
          error: 'proposal_already_applied',
          message: '该回复的变更提案已应用到工作区，无法直接覆盖重试，请先撤销或继续追问。',
        })
      }

      let userTurnIndex = -1
      for (let i = allMessages.length - 2; i >= 0; i -= 1) {
        if (allMessages[i]!.role === 'user') {
          userTurnIndex = i
          break
        }
      }
      if (userTurnIndex < 0) {
        return reply.code(400).send({ error: 'missing_user_message', message: '找不到对应的上一条用户提问' })
      }

      const userTurn = allMessages[userTurnIndex]!
      const priorRows = allMessages.slice(0, userTurnIndex)
      const activePriorRows = sliceMessagesAfterCompaction(priorRows, thread.compactedUpToMessageId)
      const history = rowsToHistoryTurns(activePriorRows)
      const pendingProposalSeed = findLatestPendingProposal(priorRows)
      const savedContext = safeJsonParse<AgentTurnContext | null>(
        userTurn.contextJson,
        null,
      )

      const body = (request.body ?? {}) as Record<string, unknown>
      await resolveTurnExecution({
        request,
        reply,
        user,
        book,
        thread,
        body,
        userMessage: userTurn.content,
        context: savedContext ?? undefined,
        history,
        pendingProposalSeed,
        nextTitle: thread.title,
        persistUserMessage: false,
        replaceMessageId: latest.id,
      })
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
      if (body.status !== 'applied' && body.status !== 'dismissed' && body.status !== 'reverted') {
        return reply.code(400).send({
          error: 'invalid_status',
          message: '状态只能是 applied、dismissed 或 reverted',
        })
      }

      const resolution = parseProposalResolution(body.resolution)

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
        .set({
          proposalStatus: body.status,
          ...(body.resolution !== undefined
            ? { proposalResolutionJson: resolution ? JSON.stringify(resolution) : null }
            : body.status === 'reverted'
              ? { proposalResolutionJson: null }
              : {}),
        })
        .where(eq(agentMessages.id, found.id))
        .returning()

      return reply.send({ message: toMessageDto(updated!) })
    },
  )
}
