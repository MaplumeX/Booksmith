import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  estimatePromptTokens,
  estimateTextTokens,
  extractModelContextWindows,
  inferModelContextWindow,
  normalizeContextWindow,
  resolveContextWindow,
} from '../src/agent/contextWindow'
import { fetchProviderModels } from '../src/agent/providers'

describe('agent contextWindow resolution & token estimation', () => {
  let mockServer: ReturnType<typeof createServer>
  let mockUrl = ''

  beforeAll(async () => {
    mockServer = createServer((req, res) => {
      if (req.url === '/openrouter/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              { id: 'custom/fast-model', context_length: 65536 },
              { id: 'custom/tiny-model', top_provider: { context_length: 16384 } },
              { id: 'custom/no-meta-model' },
            ],
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address()
        if (addr && typeof addr === 'object') mockUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()))
  })

  it('normalizes valid context windows and rejects out-of-range values', () => {
    expect(normalizeContextWindow(32768)).toBe(32768)
    expect(normalizeContextWindow('128000')).toBe(128000)
    expect(normalizeContextWindow(null)).toBeNull()
    expect(normalizeContextWindow('')).toBeNull()
    expect(normalizeContextWindow(512)).toBeNull()
    expect(normalizeContextWindow(-100)).toBeNull()
  })

  it('resolves context window with priority: profile override > provider metadata > built-in family > default', () => {
    expect(
      resolveContextWindow({
        model: 'claude-sonnet-4-20250514',
        profileContextWindow: 32_000,
        modelContextWindows: { 'claude-sonnet-4-20250514': 200_000 },
      }),
    ).toEqual({ contextWindow: 32_000, source: 'override' })

    expect(
      resolveContextWindow({
        model: 'custom/fast-model',
        modelContextWindows: { 'custom/fast-model': 65_536 },
      }),
    ).toEqual({ contextWindow: 65_536, source: 'provider' })

    expect(resolveContextWindow({ model: 'anthropic/claude-sonnet-4-20250514' })).toEqual({
      contextWindow: 200_000,
      source: 'inferred',
    })
    expect(resolveContextWindow({ model: 'gpt-4.1-mini' })).toEqual({
      contextWindow: 1_000_000,
      source: 'inferred',
    })
    expect(resolveContextWindow({ model: 'qwen2.5:14b' })).toEqual({
      contextWindow: 32_768,
      source: 'inferred',
    })
    expect(resolveContextWindow({ model: 'deepseek-reasoner' })).toEqual({
      contextWindow: 64_000,
      source: 'inferred',
    })

    expect(resolveContextWindow({ model: 'completely-unknown-relay-alias' })).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      source: 'default',
    })
    expect(inferModelContextWindow('gemini-2.5-pro').contextWindow).toBe(1_000_000)
  })

  it('extracts per-model context windows during fetchProviderModels', async () => {
    const direct = extractModelContextWindows({
      models: [{ name: 'local-8k', max_model_len: 8192 }],
    })
    expect(direct).toEqual({ 'local-8k': 8192 })

    const fetched = await fetchProviderModels({
      provider: 'openai-compatible',
      baseUrl: `${mockUrl}/openrouter/v1`,
      apiKey: null,
    })
    expect(fetched.ok).toBe(true)
    expect(fetched.models).toEqual(['custom/fast-model', 'custom/no-meta-model', 'custom/tiny-model'])
    expect(fetched.modelContextWindows).toEqual({
      'custom/fast-model': 65536,
      'custom/tiny-model': 16384,
    })
  })

  it('estimates CJK and Latin tokens reasonably for fallback budgeting', () => {
    const english = estimateTextTokens('The quick brown fox jumps over the lazy dog.')
    const chinese = estimateTextTokens('请帮我校对当前章节的错别字、标点与语病并说明修改原因。')
    expect(english).toBeGreaterThan(8)
    expect(english).toBeLessThan(25)
    expect(chinese).toBeGreaterThan(12)
    expect(chinese).toBeLessThan(35)

    const promptTokens = estimatePromptTokens({
      system: '你是 Booksmith 助手',
      messages: [
        { role: 'user', content: '你好' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.xhtml' } }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'json', value: { ok: true } } }],
        },
      ],
      includeToolsOverhead: true,
    })
    expect(promptTokens).toBeGreaterThan(2400)
  })
})
