/**
 * Model context-window resolution and CJK-aware token estimation for Booksmith's 80% auto-compaction loop.
 * See ADR 2026-11-21-agent-session-continuity.
 */

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const AUTO_COMPACT_RATIO = 0.8
export const MIN_CONTEXT_WINDOW = 2_048
export const MAX_CONTEXT_WINDOW = 10_000_000

/** Approximate overhead for tool definitions sent alongside messages when upstream usage is absent. */
export const ESTIMATED_TOOL_SCHEMA_TOKENS = 2_400

export type ContextWindowSource = 'override' | 'provider' | 'inferred' | 'default'

export interface ResolvedContextWindow {
  contextWindow: number
  source: ContextWindowSource
}

export function normalizeContextWindow(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return null
  const rounded = Math.round(num)
  if (rounded < MIN_CONTEXT_WINDOW || rounded > MAX_CONTEXT_WINDOW) return null
  return rounded
}

export function normalizeModelContextWindows(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  let count = 0
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 500) break
    const id = key.trim()
    const parsed = normalizeContextWindow(val)
    if (id && parsed !== null) {
      out[id] = parsed
      count += 1
    }
  }
  return out
}

function readContextLengthFromModelItem(item: Record<string, unknown>): number | null {
  const topProvider =
    item.top_provider && typeof item.top_provider === 'object'
      ? (item.top_provider as Record<string, unknown>)
      : null
  const candidates = [
    item.context_length,
    item.max_context_length,
    item.context_window,
    item.input_token_limit,
    item.max_input_tokens,
    item.max_model_len,
    topProvider?.context_length,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeContextWindow(candidate)
    if (normalized !== null) return normalized
  }
  return null
}

/**
 * Extracts per-model context window limits when an upstream `/models` endpoint exposes them
 * (e.g. OpenRouter `context_length`, vLLM `max_model_len`, Google `input_token_limit`).
 */
export function extractModelContextWindows(payload: unknown): Record<string, number> {
  if (!payload || typeof payload !== 'object') return {}
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []

  const out: Record<string, number> = {}
  let count = 0
  for (const rawItem of list) {
    if (count >= 500) break
    if (!rawItem || typeof rawItem !== 'object') continue
    const obj = rawItem as Record<string, unknown>
    const rawId = obj.id ?? obj.model ?? obj.name
    if (typeof rawId !== 'string' || !rawId.trim()) continue
    const ctx = readContextLengthFromModelItem(obj)
    if (ctx !== null) {
      out[rawId.trim()] = ctx
      count += 1
    }
  }
  return out
}

const KNOWN_MODEL_WINDOW_RULES: ReadonlyArray<{ pattern: RegExp; tokens: number }> = [
  // Anthropic Claude family
  { pattern: /^claude-(?:opus|sonnet|haiku|3|4).*1m\b/, tokens: 1_000_000 },
  { pattern: /^claude-(?:opus|sonnet|haiku|3|4)/, tokens: 200_000 },

  // Google Gemini family
  { pattern: /^gemini-(?:1\.5|2|3|4)/, tokens: 1_000_000 },

  // OpenAI GPT / reasoning families
  { pattern: /^gpt-4\.1/, tokens: 1_000_000 },
  { pattern: /^gpt-5/, tokens: 400_000 },
  { pattern: /^(?:o1|o3|o4)(?:-|$)/, tokens: 200_000 },
  { pattern: /^gpt-4o/, tokens: 128_000 },
  { pattern: /^gpt-4-turbo/, tokens: 128_000 },
  { pattern: /^gpt-4(?:-0\d+|-32k)?$/, tokens: 8_192 },
  { pattern: /^gpt-3\.5/, tokens: 16_385 },

  // DeepSeek family
  { pattern: /^deepseek-(?:r1|reasoner)/, tokens: 64_000 },
  { pattern: /^deepseek-(?:chat|v3|coder)/, tokens: 128_000 },

  // Qwen / Moonshot / Zhipu / Llama / Mistral
  { pattern: /^qwen.*:(?:\d+(?:\.\d+)?b|latest)/, tokens: 32_768 },
  { pattern: /^qwen(?:-?2\.5|-?3|-plus|-max|-turbo|-coder)/, tokens: 128_000 },
  { pattern: /^(?:kimi|moonshot)/, tokens: 128_000 },
  { pattern: /^glm-(?:4|5)/, tokens: 128_000 },
  { pattern: /^llama-?4/, tokens: 256_000 },
  { pattern: /^llama-?3\.[123]/, tokens: 128_000 },
  { pattern: /^(?:mistral|mixtral|codestral)/, tokens: 32_768 },
]

function stripProviderPrefix(model: string): string {
  const lower = model.trim().toLowerCase()
  const slash = lower.lastIndexOf('/')
  return slash >= 0 ? lower.slice(slash + 1) : lower
}

export function inferModelContextWindow(model: string): { contextWindow: number; matched: boolean } {
  const normalized = stripProviderPrefix(model)
  if (!normalized) return { contextWindow: DEFAULT_CONTEXT_WINDOW, matched: false }

  for (const rule of KNOWN_MODEL_WINDOW_RULES) {
    if (rule.pattern.test(normalized)) {
      return { contextWindow: rule.tokens, matched: true }
    }
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, matched: false }
}

/**
 * Resolves a model's context window using a 3-tier strategy:
 * 1. Explicit per-profile user override (`profileContextWindow`)
 * 2. Provider-reported `/models` metadata (`modelContextWindows[model]`)
 * 3. Built-in model-family table, falling back to `DEFAULT_CONTEXT_WINDOW` (128K).
 */
export function resolveContextWindow(options: {
  model: string
  profileContextWindow?: number | null
  modelContextWindows?: Record<string, number> | null
}): ResolvedContextWindow {
  const override = normalizeContextWindow(options.profileContextWindow)
  if (override !== null) {
    return { contextWindow: override, source: 'override' }
  }

  const trimmedModel = options.model.trim()
  if (trimmedModel && options.modelContextWindows) {
    const reported = normalizeContextWindow(options.modelContextWindows[trimmedModel])
    if (reported !== null) {
      return { contextWindow: reported, source: 'provider' }
    }
  }

  const inferred = inferModelContextWindow(trimmedModel)
  return {
    contextWindow: inferred.contextWindow,
    source: inferred.matched ? 'inferred' : 'default',
  }
}

/**
 * Calibrated CJK + Latin token estimator used when upstream providers omit `usage.inputTokens`
 * or when estimating incremental prompt growth before sending a request.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let asciiChars = 0
  let nonAsciiChars = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code <= 0x7f) asciiChars += 1
    else nonAsciiChars += 1
  }
  const estimated = Math.ceil(asciiChars * 0.28 + nonAsciiChars * 0.68)
  return Math.max(1, estimated)
}

function estimateUnknownValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTextTokens(value)
  if (value === null || value === undefined) return 0
  try {
    return estimateTextTokens(JSON.stringify(value))
  } catch {
    return 16
  }
}

export function estimateMessageTokens(message: { role?: string; content?: unknown }): number {
  let tokens = 6 // role & framing overhead
  const { content } = message
  if (typeof content === 'string') {
    return tokens + estimateTextTokens(content)
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const obj = part as Record<string, unknown>
      if (obj.type === 'text' && typeof obj.text === 'string') {
        tokens += estimateTextTokens(obj.text)
      } else if (obj.type === 'tool-call') {
        tokens += 12 + estimateTextTokens(String(obj.toolName ?? '')) + estimateUnknownValueTokens(obj.input)
      } else if (obj.type === 'tool-result') {
        tokens += 12 + estimateTextTokens(String(obj.toolName ?? '')) + estimateUnknownValueTokens(obj.output)
      } else {
        tokens += estimateUnknownValueTokens(obj)
      }
    }
    return tokens
  }
  return tokens + estimateUnknownValueTokens(content)
}

export function estimatePromptTokens(options: {
  system?: string
  messages: ReadonlyArray<{ role?: string; content?: unknown }>
  includeToolsOverhead?: boolean
}): number {
  let total = options.system ? estimateTextTokens(options.system) + 8 : 0
  if (options.includeToolsOverhead) total += ESTIMATED_TOOL_SCHEMA_TOKENS
  for (const msg of options.messages) {
    total += estimateMessageTokens(msg)
  }
  return total
}
