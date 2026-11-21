import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, RetryError, generateText, type LanguageModel } from 'ai'
import { extractModelContextWindows } from './contextWindow'

/**
 * Dual-protocol LLM provider factory (OpenAI-compatible & Anthropic) via Vercel AI SDK.
 * Allows http/https URLs including local/LAN endpoints (Ollama/vLLM) under Booksmith's
 * trusted self-hosted `ALLOWED_EMAILS` threat model. See ADR 2026-11-20-builtin-epub-agent.
 */

export type AgentProviderType = 'openai-compatible' | 'anthropic'

export const AGENT_PROVIDERS: readonly AgentProviderType[] = ['openai-compatible', 'anthropic'] as const

export interface ResolvedProviderConfig {
  provider: AgentProviderType
  baseUrl: string
  model: string
  apiKey: string | null
}

export class InvalidProviderConfigError extends Error {
  readonly code = 'invalid_provider_config'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidProviderConfigError'
  }
}

export function isAgentProvider(value: unknown): value is AgentProviderType {
  return value === 'openai-compatible' || value === 'anthropic'
}

export function validateBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new InvalidProviderConfigError('Base URL 不能为空')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new InvalidProviderConfigError('Base URL 格式无效，请填写完整的 http:// 或 https:// 地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidProviderConfigError('Base URL 仅支持 http:// 或 https:// 协议')
  }
  return trimmed.replace(/\/+$/, '')
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl)
  if (!parsed.pathname || parsed.pathname === '/') {
    return `${baseUrl}/v1`
  }
  return baseUrl
}

export function createLanguageModel(config: ResolvedProviderConfig): LanguageModel {
  const cleanUrl = validateBaseUrl(config.baseUrl)
  const modelId = config.model.trim()
  if (!modelId) throw new InvalidProviderConfigError('模型名称不能为空')

  if (config.provider === 'anthropic') {
    const provider = createAnthropic({
      baseURL: normalizeAnthropicBaseUrl(cleanUrl),
      apiKey: config.apiKey ?? '',
    })
    return provider(modelId)
  }

  const provider = createOpenAICompatible({
    name: 'booksmith-openai-compatible',
    baseURL: cleanUrl,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  })
  return provider.chatModel(modelId)
}

export interface ClassifiedError {
  code: string
  message: string
}

export function classifyProviderError(error: unknown): ClassifiedError {
  if (RetryError.isInstance(error) && error.lastError) {
    return classifyProviderError(error.lastError)
  }

  if (error instanceof InvalidProviderConfigError) {
    return { code: error.code, message: error.message }
  }

  if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))) {
    return { code: 'aborted', message: '已停止生成' }
  }

  if (error instanceof Error && (error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message))) {
    return { code: 'timeout', message: '模型服务响应超时，请稍后重试或检查网络连通性' }
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    if (status === 401 || status === 403) {
      return { code: 'auth_failed', message: `模型鉴权失败（HTTP ${status}），请检查 API Key 或权限` }
    }
    if (status === 404) {
      return { code: 'model_not_found', message: '接口或模型不存在（HTTP 404），请检查 Base URL 与模型名称' }
    }
    if (status === 429) {
      return { code: 'rate_limited', message: '模型服务触发限流（HTTP 429），请稍后再试' }
    }
    return {
      code: 'upstream_error',
      message: `模型服务返回错误（HTTP ${status ?? 'unknown'}）：${error.message.slice(0, 240)}`,
    }
  }

  const raw = error instanceof Error ? error.message : String(error)
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(raw)) {
    return { code: 'network_error', message: `无法连接到模型服务：${raw.slice(0, 180)}` }
  }
  return { code: 'upstream_error', message: raw.slice(0, 240) || '模型调用失败' }
}

export interface ConnectionTestResult {
  ok: boolean
  latencyMs: number
  reply?: string
  errorCode?: string
  error?: string
}

export interface ProviderModelsResult {
  ok: boolean
  models: string[]
  modelContextWindows?: Record<string, number>
  errorCode?: string
  error?: string
}

const MAX_FETCHED_MODELS = 500

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const found = new Set<string>()

  // Standard OpenAI & Anthropic shape: { data: [{ id: "..." }] }
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      if (item && typeof item === 'object') {
        const id = (item as Record<string, unknown>).id
        if (typeof id === 'string' && id.trim()) found.add(id.trim())
      } else if (typeof item === 'string' && item.trim()) {
        found.add(item.trim())
      }
      if (found.size >= MAX_FETCHED_MODELS) break
    }
  }

  // Fallback for native Ollama / proxy shape: { models: [{ name | id | model }] }
  if (found.size === 0 && Array.isArray(record.models)) {
    for (const item of record.models) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const candidate = obj.id ?? obj.model ?? obj.name
        if (typeof candidate === 'string' && candidate.trim()) found.add(candidate.trim())
      } else if (typeof item === 'string' && item.trim()) {
        found.add(item.trim())
      }
      if (found.size >= MAX_FETCHED_MODELS) break
    }
  }

  return Array.from(found).sort((a, b) => a.localeCompare(b))
}

/**
 * Fetches available model IDs from an OpenAI-compatible or Anthropic provider server-side
 * so stored encrypted API keys never leave the server and browser CORS is avoided.
 * See ADR 2026-11-20-agent-modes-and-multimodel.
 */
export async function fetchProviderModels(
  config: Pick<ResolvedProviderConfig, 'provider' | 'baseUrl' | 'apiKey'>,
  timeoutMs = 10_000,
): Promise<ProviderModelsResult> {
  let cleanUrl: string
  try {
    cleanUrl = validateBaseUrl(config.baseUrl)
  } catch (error) {
    const classified = classifyProviderError(error)
    return { ok: false, models: [], errorCode: classified.code, error: classified.message }
  }

  const endpoint =
    config.provider === 'anthropic'
      ? `${normalizeAnthropicBaseUrl(cleanUrl)}/models`
      : `${cleanUrl}/models`

  const headers: Record<string, string> = { accept: 'application/json' }
  if (config.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (config.apiKey) headers['x-api-key'] = config.apiKey
  } else if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`
  }

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          models: [],
          errorCode: 'auth_failed',
          error: `模型列表鉴权失败（HTTP ${response.status}），请检查 API Key 或手动填写模型名`,
        }
      }
      if (response.status === 404 || response.status === 405) {
        return {
          ok: false,
          models: [],
          errorCode: 'models_endpoint_unsupported',
          error: '该服务端点未开放 /models 接口，请直接手动输入模型名称',
        }
      }
      if (response.status === 429) {
        return {
          ok: false,
          models: [],
          errorCode: 'rate_limited',
          error: '拉取模型列表触发限流（HTTP 429），请稍后再试或手动填写',
        }
      }
      return {
        ok: false,
        models: [],
        errorCode: 'upstream_error',
        error: `拉取模型列表失败（HTTP ${response.status}），请稍后重试或手动填写`,
      }
    }

    const payload = (await response.json().catch(() => null)) as unknown
    const models = extractModelIds(payload)
    const modelContextWindows = extractModelContextWindows(payload)
    if (models.length === 0) {
      return {
        ok: false,
        models: [],
        errorCode: 'empty_model_list',
        error: '服务端点未返回可识别的模型列表，请手动填写模型名称',
      }
    }
    return {
      ok: true,
      models,
      ...(Object.keys(modelContextWindows).length > 0 ? { modelContextWindows } : {}),
    }
  } catch (error) {
    const classified = classifyProviderError(error)
    return { ok: false, models: [], errorCode: classified.code, error: classified.message }
  }
}

export async function testProfileConnection(
  config: ResolvedProviderConfig,
  timeoutMs = 15_000,
): Promise<ConnectionTestResult> {
  const started = Date.now()
  try {
    const model = createLanguageModel(config)
    const result = await generateText({
      model,
      maxOutputTokens: 16,
      maxRetries: 0,
      prompt: 'Reply with OK.',
      abortSignal: AbortSignal.timeout(timeoutMs),
    })
    return {
      ok: true,
      latencyMs: Date.now() - started,
      reply: result.text.trim().slice(0, 60),
    }
  } catch (error) {
    const classified = classifyProviderError(error)
    return {
      ok: false,
      latencyMs: Date.now() - started,
      errorCode: classified.code,
      error: classified.message,
    }
  }
}
