import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, RetryError, generateText, type LanguageModel } from 'ai'

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
