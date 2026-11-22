import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createEmptyEpub, openEpub, zipArchive } from '@booksmith/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeXmlCodec } from '../src/agent/nodeXmlCodec'
import { fetchProviderModels, testProfileConnection, validateBaseUrl } from '../src/agent/providers'
import { normalizeMaxToolSteps, runAgentTurn, trimHistory, type AgentStreamEvent } from '../src/agent/runner'
import { buildSystemPrompt, formatUserMessageWithContext } from '../src/agent/systemPrompt'
import { ingestEpub, nodeXmlParser } from '../src/epub/ingest'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function writeOpenAiSse(res: ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

function writeAnthropicSse(res: ServerResponse, events: Array<{ event: string; data: unknown }>) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  for (const item of events) {
    res.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
  }
  res.end()
}

describe('agent providers & runner with local mock LLM servers', () => {
  let mockUrl = ''
  let server: ReturnType<typeof createServer>
  let openAiStep = 0
  let anthropicStep = 0
  let abortToolsCalls = 0
  let lastAskRequest: Record<string, unknown> | null = null
  let askRequests: Array<Record<string, unknown>> = []
  let anthropicCapturedBodies: Array<Record<string, unknown>> = []
  let oaiImageStep = 0
  let oaiImageBodies: Array<Record<string, unknown>> = []
  let anthImageStep = 0
  let anthImageBodies: Array<Record<string, unknown>> = []
  let compactCalls = 0
  let compactFailMode = false

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const bodyText = await readBody(req)
      const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}

      // Auth failure simulation
      if (url.pathname.startsWith('/auth-fail')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
      if (url.pathname.startsWith('/rate-limit')) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'too many requests' } }))
        return
      }

      // Provider model listing endpoints (OpenAI-compatible, Ollama fallback, Anthropic)
      if (url.pathname === '/openai/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }, { id: 'gpt-4.1' }],
          }),
        )
        return
      }
      if (url.pathname === '/ollama/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }, { name: 'deepseek-r1:8b' }] }))
        return
      }
      if (url.pathname === '/anthropic/v1/models' && req.method === 'GET') {
        if (req.headers['x-api-key'] !== 'sk-ant-mock') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: 'claude-sonnet-4-20250514' }, { id: 'claude-opus-4-20250514' }],
          }),
        )
        return
      }

      // OpenAI-compatible reasoning stream endpoint (DeepSeek-R1 / reasoning_content)
      if (url.pathname === '/openai-reasoning/v1/chat/completions') {
        writeOpenAiSse(res, [
          {
            id: 'r1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-reasoner',
            choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先核对段落结构，' }, finish_reason: null }],
          },
          {
            id: 'r1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-reasoner',
            choices: [{ index: 0, delta: { reasoning_content: '再确认标点规范。' }, finish_reason: null }],
          },
          {
            id: 'r1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-reasoner',
            choices: [{ index: 0, delta: { content: '正文标点无误。' }, finish_reason: 'stop' }],
          },
        ])
        return
      }

      // Anthropic thinking stream endpoint
      if (url.pathname === '/anthropic-thinking/v1/messages') {
        writeAnthropicSse(res, [
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_think',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-20250514',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 1 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '分析目录层级。' } },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '目录层级清晰。' } },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 8 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ])
        return
      }

      // Ask-mode inspection endpoint: captures registered tools & system prompt
      if (url.pathname === '/ask-check/v1/chat/completions') {
        lastAskRequest = body
        askRequests.push(body)
        if (body.stream !== true) {
          compactCalls += 1
          if (compactFailMode) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'compaction upstream failure' } }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: `cmp_${compactCalls}`,
              object: 'chat.completion',
              created: 1,
              model: body.model ?? 'mock-ask',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: '【压缩摘要】用户约定保留学术术语，已核对第一章前 200 行并定位 2 处标点问题。',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
            }),
          )
          return
        }
        writeOpenAiSse(res, [
          {
            id: 'ask1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-ask',
            choices: [{ index: 0, delta: { role: 'assistant', content: '仅给出只读校对建议。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 320, completion_tokens: 16, total_tokens: 336 },
          },
        ])
        return
      }

      // Anthropic multimodal inspect_image endpoint
      if (url.pathname === '/anthropic-image/v1/messages') {
        anthImageBodies.push(body)
        anthImageStep += 1
        if (anthImageStep === 1) {
          writeAnthropicSse(res, [
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: {
                  id: 'msg_img_1',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-sonnet-4-20250514',
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 100, output_tokens: 1 },
                },
              },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'toolu_img_1', name: 'inspect_image', input: {} },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify({ path: 'EPUB/images/chart.png' }),
                },
              },
            },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 10 },
              },
            },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ])
          return
        }
        writeAnthropicSse(res, [
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_img_2',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-20250514',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 300, output_tokens: 1 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已识别图表内容。' } },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 8 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ])
        return
      }

      // OpenAI-compatible multimodal inspect_image endpoint
      if (url.pathname === '/openai-image/v1/chat/completions') {
        oaiImageBodies.push(body)
        oaiImageStep += 1
        if (oaiImageStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'img1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_img_1',
                        type: 'function',
                        function: {
                          name: 'inspect_image',
                          arguments: JSON.stringify({ path: 'EPUB/images/chart.png' }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'img1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-4o',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        writeOpenAiSse(res, [
          {
            id: 'img2',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-4o',
            choices: [{ index: 0, delta: { role: 'assistant', content: '图表为 120×80 PNG。' }, finish_reason: 'stop' }],
          },
        ])
        return
      }

      // Anthropic replay inspection endpoint
      if (url.pathname === '/anthropic-replay/v1/messages') {
        anthropicCapturedBodies.push(body)
        writeAnthropicSse(res, [
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_rep',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-20250514',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 480, output_tokens: 1 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已衔接上一轮工具结果继续回复。' } },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 12 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ])
        return
      }

      // Slow stream for abort testing
      if (url.pathname === '/slow/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-slow',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-oai',
            choices: [{ index: 0, delta: { role: 'assistant', content: '正在分析…' }, finish_reason: null }],
          })}\n\n`,
        )
        const timer = setTimeout(() => {
          if (!res.writableEnded) res.end()
        }, 5000)
        res.on('close', () => clearTimeout(timer))
        return
      }

      // Multi-tool step for verifying abort stops subsequent tools and LLM steps
      if (url.pathname === '/abort-tools/chat/completions') {
        abortToolsCalls += 1
        writeOpenAiSse(res, [
          {
            id: `at-${abortToolsCalls}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-oai',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_abort_1',
                      type: 'function',
                      function: { name: 'list_files', arguments: '{}' },
                    },
                    {
                      index: 1,
                      id: 'call_abort_2',
                      type: 'function',
                      function: {
                        name: 'edit_file',
                        arguments: JSON.stringify({
                          path: 'EPUB/text/ch001.xhtml',
                          oldText: '<p>从这里开始写。</p>',
                          newText: '<p>不应被执行。</p>',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: `at-${abortToolsCalls}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-oai',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          },
        ])
        return
      }

      // OpenAI-compatible mock endpoint
      if (url.pathname === '/openai/v1/chat/completions') {
        if (body.stream !== true) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'chatcmpl-ping',
              object: 'chat.completion',
              created: 1,
              model: body.model ?? 'mock-oai',
              choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            }),
          )
          return
        }

        openAiStep += 1
        if (openAiStep === 1) {
          // Step 1: attempt malformed XML edit first so runner feeds XML error back to model
          writeOpenAiSse(res, [
            {
              id: 'c1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-oai',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_bad_xml',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<p>从这里开始写。</p>',
                            newText: '<p>坏掉的标签</div>',
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'c1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-oai',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }

        if (openAiStep === 2) {
          // Step 2: model sees XML error and self-corrects with valid XHTML
          writeOpenAiSse(res, [
            {
              id: 'c2',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-oai',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_good_xml',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<p>从这里开始写。</p>',
                            newText: '<p>已经校对完成的正文。</p>',
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'c2',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-oai',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }

        // Step 3: final assistant summary text
        writeOpenAiSse(res, [
          {
            id: 'c3',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-oai',
            choices: [{ index: 0, delta: { role: 'assistant', content: '已完成第一章正文校对，' }, finish_reason: null }],
          },
          {
            id: 'c3',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-oai',
            choices: [{ index: 0, delta: { content: '请审阅 Diff 后应用。' }, finish_reason: 'stop' }],
          },
        ])
        return
      }

      // Anthropic Messages mock endpoint
      if (url.pathname === '/anthropic/v1/messages') {
        if (body.stream !== true) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'msg_ping',
              type: 'message',
              role: 'assistant',
              model: body.model ?? 'mock-claude',
              content: [{ type: 'text', text: 'OK' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 2 },
            }),
          )
          return
        }

        anthropicStep += 1
        if (anthropicStep === 1) {
          writeAnthropicSse(res, [
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: {
                  id: 'msg_1',
                  type: 'message',
                  role: 'assistant',
                  model: 'mock-claude',
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 10, output_tokens: 1 },
                },
              },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'toolu_meta', name: 'update_metadata', input: {} },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify({ metadata: { title: '数理分析修订版' } }),
                },
              },
            },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 12 },
              },
            },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ])
          return
        }

        writeAnthropicSse(res, [
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_2',
                type: 'message',
                role: 'assistant',
                model: 'mock-claude',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 20, output_tokens: 1 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已更新书名元数据。' } },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 8 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ])
        return
      }

      res.writeHead(404)
      res.end('not found')
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') mockUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('validates base URLs and tests both OpenAI-compatible and Anthropic connections', async () => {
    expect(() => validateBaseUrl('file:///etc/passwd')).toThrow()
    expect(validateBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1')

    const oaiOk = await testProfileConnection({
      provider: 'openai-compatible',
      baseUrl: `${mockUrl}/openai/v1`,
      model: 'mock-oai',
      apiKey: null,
    })
    expect(oaiOk.ok).toBe(true)
    expect(oaiOk.reply).toBe('OK')

    const anthOk = await testProfileConnection({
      provider: 'anthropic',
      baseUrl: `${mockUrl}/anthropic/v1`,
      model: 'mock-claude',
      apiKey: 'sk-ant-mock',
    })
    expect(anthOk.ok).toBe(true)

    const authFail = await testProfileConnection({
      provider: 'openai-compatible',
      baseUrl: `${mockUrl}/auth-fail`,
      model: 'mock-oai',
      apiKey: 'bad-key',
    })
    expect(authFail.ok).toBe(false)
    expect(authFail.errorCode).toBe('auth_failed')

    const rateLimit = await testProfileConnection({
      provider: 'openai-compatible',
      baseUrl: `${mockUrl}/rate-limit`,
      model: 'mock-oai',
      apiKey: 'key',
    })
    expect(rateLimit.ok).toBe(false)
    expect(rateLimit.errorCode).toBe('rate_limited')
  })

  it('runs OpenAI-compatible multi-step tool loop with XML self-correction and emits proposal', async () => {
    openAiStep = 0
    const { archive } = openEpub(createEmptyEpub({ title: '测试书' }), nodeXmlCodec.parse)
    const events: AgentStreamEvent[] = []

    const result = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/openai/v1`,
        model: 'mock-oai',
        apiKey: 'sk-test',
      },
      history: [],
      userMessage: '校对第一章',
      context: { activePath: 'EPUB/text/ch001.xhtml' },
      onEvent: (event) => events.push(event),
    })

    expect(result.error).toBeNull()
    expect(result.stopped).toBe(false)
    expect(result.content).toBe('已完成第一章正文校对，请审阅 Diff 后应用。')
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0]!.ok).toBe(false)
    expect(result.toolCalls[1]!.ok).toBe(true)
    expect(result.proposal).not.toBeNull()
    expect(result.proposal!.isStructural).toBe(false)
    expect(result.proposal!.validationIssues).toEqual([])
    expect(result.proposal!.files[0]!.afterText).toContain('已经校对完成的正文。')
    // Failed first edit_file must NOT emit proposal_update; successful second edit_file emits live proposal_update before final proposal.
    const updates = events.filter((e) => e.type === 'proposal_update')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.delta.proposalId).toBe(result.proposal!.id)
    expect(updates[0]!.delta.focusPath).toBe('EPUB/text/ch001.xhtml')
    expect(updates[0]!.delta.changedFiles).toHaveLength(1)
    expect(events.findIndex((e) => e.type === 'proposal_update')).toBeLessThan(
      events.findIndex((e) => e.type === 'proposal'),
    )
    expect(events.some((e) => e.type === 'proposal')).toBe(true)
    expect(events.at(-1)?.type).toBe('done')

    // Auto mode must NOT emit mid-turn proposal_update events (only end-of-turn proposal).
    openAiStep = 0
    const autoEvents: AgentStreamEvent[] = []
    const autoRes = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/openai/v1`,
        model: 'mock-oai',
        apiKey: 'sk-test',
      },
      history: [],
      userMessage: '自动校对第一章',
      approvalMode: 'auto',
      onEvent: (event) => autoEvents.push(event),
    })
    expect(autoRes.proposal).not.toBeNull()
    expect(autoEvents.some((e) => e.type === 'proposal_update')).toBe(false)
    expect(autoEvents.some((e) => e.type === 'proposal')).toBe(true)
  })

  it('runs Anthropic tool loop on real MathML fixture and preserves EPUB validity & untouched chapters', async () => {
    anthropicStep = 0
    const fixtureBytes = readFileSync(new URL('../../../fixtures/马克思经济学与数理分析.epub', import.meta.url))
    const { archive, pkg } = openEpub(new Uint8Array(fixtureBytes), nodeXmlParser)

    const result = await runAgentTurn({
      archive,
      provider: {
        provider: 'anthropic',
        baseUrl: `${mockUrl}/anthropic/v1`,
        model: 'mock-claude',
        apiKey: 'sk-ant-mock',
      },
      history: [],
      userMessage: '把书名改成数理分析修订版',
    })

    expect(result.error).toBeNull()
    expect(result.content).toBe('已更新书名元数据。')
    expect(result.proposal).not.toBeNull()
    expect(result.proposal!.isStructural).toBe(true)
    expect(result.proposal!.validationIssues).toEqual([])
    expect(result.proposal!.files).toHaveLength(1)
    expect(result.proposal!.files[0]!.path).toBe(pkg.opfPath)

    // Verify applying the serialized OPF back into the real fixture passes full server ingest!
    const nextEntries = new Map(archive.entries)
    nextEntries.set(pkg.opfPath, new TextEncoder().encode(result.proposal!.files[0]!.afterText!))
    const repacked = zipArchive({ order: archive.order, entries: nextEntries })
    const ingested = ingestEpub(Buffer.from(repacked))
    expect(ingested.title).toBe('数理分析修订版')
    // Untouched MathML chapters stay byte-identical.
    for (const [path, bytes] of archive.entries) {
      if (path === pkg.opfPath) continue
      expect(Buffer.from(ingested.archive.entries.get(path)!).equals(Buffer.from(bytes))).toBe(true)
    }
  })

  it('aborts cleanly on AbortSignal without producing a proposal', async () => {
    const { archive } = openEpub(createEmptyEpub({ title: '中止测试' }), nodeXmlCodec.parse)
    const controller = new AbortController()
    const events: AgentStreamEvent[] = []

    const result = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/slow`,
        model: 'mock-oai',
        apiKey: null,
      },
      history: [],
      userMessage: '开始分析',
      abortSignal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'text_delta') controller.abort()
      },
    })

    expect(result.stopped).toBe(true)
    expect(result.error).toBeNull()
    expect(result.proposal).toBeNull()
    expect(result.content).toBe('正在分析…')
    expect(events.at(-1)).toEqual({ type: 'done', stopped: true })
  })

  it('aborts immediately before LLM call when signal is pre-aborted and halts subsequent tools & steps', async () => {
    const { archive } = openEpub(createEmptyEpub({ title: '工具中止测试' }), nodeXmlCodec.parse)

    // Pre-aborted signal must not contact upstream provider at all
    abortToolsCalls = 0
    const preAborted = new AbortController()
    preAborted.abort()
    const preResult = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/abort-tools`,
        model: 'mock-oai',
        apiKey: null,
      },
      history: [],
      userMessage: '不要调用模型',
      abortSignal: preAborted.signal,
    })
    expect(preResult.stopped).toBe(true)
    expect(preResult.error).toBeNull()
    expect(preResult.proposal).toBeNull()
    expect(abortToolsCalls).toBe(0)

    // Abort on the first tool_end: second tool and step 2 must not run
    abortToolsCalls = 0
    const controller = new AbortController()
    const events: AgentStreamEvent[] = []
    const midResult = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/abort-tools`,
        model: 'mock-oai',
        apiKey: null,
      },
      history: [],
      userMessage: '连续调用两个工具',
      abortSignal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'tool_end') controller.abort()
      },
    })
    expect(midResult.stopped).toBe(true)
    expect(midResult.error).toBeNull()
    expect(midResult.proposal).toBeNull()
    expect(abortToolsCalls).toBe(1)
    expect(midResult.toolCalls).toHaveLength(1)
    expect(midResult.toolCalls[0]?.name).toBe('list_files')
    expect(events.at(-1)).toEqual({ type: 'done', stopped: true })
  })

  it('trims long conversation history deterministically within character budget', () => {
    const trimmed = trimHistory(
      [
        { role: 'user', content: 'A'.repeat(100) },
        { role: 'assistant', content: 'B'.repeat(100) },
        { role: 'user', content: 'C'.repeat(80) },
      ],
      190,
    )
    expect(trimmed).toHaveLength(2)
    expect(trimmed[0]!.content).toBe('B'.repeat(100))
    expect(trimmed[1]!.content).toBe('C'.repeat(80))
  })

  it('fetches provider models for OpenAI-compatible, Ollama fallback, and Anthropic with graceful errors', async () => {
    const oai = await fetchProviderModels({
      provider: 'openai-compatible',
      baseUrl: `${mockUrl}/openai/v1`,
      apiKey: 'sk-test',
    })
    expect(oai.ok).toBe(true)
    expect(oai.models).toEqual(['gpt-4.1', 'gpt-4.1-mini'])

    const ollama = await fetchProviderModels({
      provider: 'openai-compatible',
      baseUrl: `${mockUrl}/ollama/v1`,
      apiKey: null,
    })
    expect(ollama.ok).toBe(true)
    expect(ollama.models).toEqual(['deepseek-r1:8b', 'qwen2.5:14b'])

    const anth = await fetchProviderModels({
      provider: 'anthropic',
      baseUrl: `${mockUrl}/anthropic/v1`,
      apiKey: 'sk-ant-mock',
    })
    expect(anth.ok).toBe(true)
    expect(anth.models).toEqual(['claude-opus-4-20250514', 'claude-sonnet-4-20250514'])

    const unsupported = await fetchProviderModels({
      provider: 'openai-compatible',
      baseUrl: `${mockUrl}/missing`,
      apiKey: null,
    })
    expect(unsupported.ok).toBe(false)
    expect(unsupported.errorCode).toBe('models_endpoint_unsupported')

    const authErr = await fetchProviderModels({
      provider: 'anthropic',
      baseUrl: `${mockUrl}/anthropic/v1`,
      apiKey: 'wrong-key',
    })
    expect(authErr.ok).toBe(false)
    expect(authErr.errorCode).toBe('auth_failed')
  })

  it('restricts tools to read-only in ask mode and injects custom instructions + user-defined maxSteps', async () => {
    expect(normalizeMaxToolSteps(undefined)).toBe(15)
    expect(normalizeMaxToolSteps(0)).toBe(0)
    expect(normalizeMaxToolSteps(1)).toBe(1)
    expect(normalizeMaxToolSteps(120)).toBe(120)

    lastAskRequest = null
    const { archive } = openEpub(createEmptyEpub({ title: '只读测试书' }), nodeXmlCodec.parse)
    const result = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/ask-check/v1`,
        model: 'mock-ask',
        apiKey: null,
      },
      history: [],
      userMessage: '帮我看一下哪里有错字',
      approvalMode: 'ask',
      customInstructions: '请保留民国纪年与所有 MathML 公式原貌。',
      maxSteps: 8,
    })

    expect(result.error).toBeNull()
    expect(result.proposal).toBeNull()
    expect(result.content).toBe('仅给出只读校对建议。')

    const captured = lastAskRequest as Record<string, unknown> | null
    const tools = (captured?.tools as Array<{ function?: { name?: string } }>) ?? []
    const toolNames = tools.map((t) => t.function?.name).sort()
    expect(toolNames).toEqual([
      'find_references',
      'get_metadata',
      'get_toc',
      'inspect_image',
      'lint_book',
      'list_anchors',
      'list_files',
      'read_file',
      'scan_headings',
      'search_book',
    ])

    const messages = (captured?.messages as Array<{ role: string; content: string }>) ?? []
    const systemMsg = messages.find((m) => m.role === 'system')?.content ?? ''
    expect(systemMsg).toContain('只读顾问模式')
    expect(systemMsg).toContain('请保留民国纪年与所有 MathML 公式原貌。')
  })

  it('streams reasoning_delta events for both OpenAI-compatible reasoning_content and Anthropic thinking', async () => {
    const { archive } = openEpub(createEmptyEpub({ title: '思考测试书' }), nodeXmlCodec.parse)

    const oaiEvents: AgentStreamEvent[] = []
    const oaiResult = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/openai-reasoning/v1`,
        model: 'deepseek-reasoner',
        apiKey: null,
      },
      history: [],
      userMessage: '检查标点',
      onEvent: (event) => oaiEvents.push(event),
    })

    expect(oaiResult.error).toBeNull()
    expect(oaiResult.reasoning).toBe('先核对段落结构，再确认标点规范。')
    expect(oaiResult.content).toBe('正文标点无误。')
    expect(oaiEvents.filter((e) => e.type === 'reasoning_delta').map((e) => e.text).join('')).toBe(
      '先核对段落结构，再确认标点规范。',
    )

    const anthEvents: AgentStreamEvent[] = []
    const anthResult = await runAgentTurn({
      archive,
      provider: {
        provider: 'anthropic',
        baseUrl: `${mockUrl}/anthropic-thinking/v1`,
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-mock',
      },
      history: [],
      userMessage: '检查目录',
      onEvent: (event) => anthEvents.push(event),
    })

    expect(anthResult.error).toBeNull()
    expect(anthResult.reasoning).toBe('分析目录层级。')
    expect(anthResult.content).toBe('目录层级清晰。')
    expect(anthEvents.some((e) => e.type === 'reasoning_delta')).toBe(true)
  })

  it('keeps system prompt identical across page switches and attaches per-turn context to user messages', async () => {
    askRequests = []
    const { archive, pkg } = openEpub(createEmptyEpub({ title: '缓存稳定测试书' }), nodeXmlCodec.parse)

    // Pure formatting checks (including backtick fence escaping and truncation)
    expect(formatUserMessageWithContext('纯文本提问')).toBe('纯文本提问')
    expect(formatUserMessageWithContext('纯文本提问', { activePath: '  ', selection: '   ' })).toBe('纯文本提问')
    const fenced = formatUserMessageWithContext('检查这段', {
      activePath: 'EPUB/text/ch001.xhtml',
      selection: '含```三重反引号```的选区',
      selectionStartLine: 12,
      selectionEndLine: 15,
    })
    expect(fenced).toContain('用户选中的文本片段（第 12–15 行）：')
    expect(fenced).toContain('````\n含```三重反引号```的选区\n````')

    const longSelection = '甲'.repeat(4100)
    const truncated = formatUserMessageWithContext('检查超长选区', { selection: longSelection })
    expect(truncated).toContain('...(已截断)')
    expect(truncated.length).toBeLessThan(4100)

    const systemPrompt = buildSystemPrompt(pkg, { approvalMode: 'ask', customInstructions: '保留术语。' })
    expect(systemPrompt).not.toContain('ch001.xhtml')
    expect(systemPrompt).toContain('保留术语。')

    // trimHistory accounts for formatted user context length in its budget
    const historyWithCtx = trimHistory(
      [
        { role: 'user', content: '第一轮', context: { activePath: 'EPUB/text/ch001.xhtml', selection: 'S'.repeat(120) } },
        { role: 'assistant', content: '回复一' },
        { role: 'user', content: '第二轮', context: { activePath: 'EPUB/text/ch002.xhtml' } },
      ],
      160,
    )
    expect(historyWithCtx).toHaveLength(2)
    expect(historyWithCtx[0]!.content).toBe('回复一')
    expect(historyWithCtx[1]!.content).toContain('EPUB/text/ch002.xhtml')

    // Turn 1 on ch001.xhtml
    const turn1Context = { activePath: 'EPUB/text/ch001.xhtml', selection: '第一章选中的片段' }
    const turn1 = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/ask-check/v1`,
        model: 'mock-ask',
        apiKey: null,
      },
      history: [],
      userMessage: '帮我检查这一页',
      context: turn1Context,
      approvalMode: 'ask',
      customInstructions: '保留学术术语。',
    })
    expect(turn1.error).toBeNull()

    // Turn 2 after switching to ch002.xhtml with a different selection
    const turn2Context = { activePath: 'EPUB/text/ch002.xhtml', selection: '第二章选中的片段' }
    const turn2 = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/ask-check/v1`,
        model: 'mock-ask',
        apiKey: null,
      },
      history: [
        { role: 'user', content: '帮我检查这一页', context: turn1Context },
        { role: 'assistant', content: turn1.content },
      ],
      userMessage: '再看看这一页',
      context: turn2Context,
      approvalMode: 'ask',
      customInstructions: '保留学术术语。',
    })
    expect(turn2.error).toBeNull()

    expect(askRequests).toHaveLength(2)
    const req1Msgs = (askRequests[0]!.messages as Array<{ role: string; content: string }>) ?? []
    const req2Msgs = (askRequests[1]!.messages as Array<{ role: string; content: string }>) ?? []

    const sys1 = req1Msgs.find((m) => m.role === 'system')?.content ?? ''
    const sys2 = req2Msgs.find((m) => m.role === 'system')?.content ?? ''
    expect(sys1).toBe(sys2)
    expect(sys1).not.toContain('ch001.xhtml')
    expect(sys1).not.toContain('ch002.xhtml')
    expect(sys1).not.toContain('第一章选中的片段')
    expect(sys1).not.toContain('第二章选中的片段')

    // Replayed turn-1 user message must be byte-identical to turn-1's original user message for prefix cache hits
    expect(req2Msgs[1]).toEqual(req1Msgs[1])
    expect(req1Msgs[1]!.content).toContain('EPUB/text/ch001.xhtml')
    expect(req1Msgs[1]!.content).toContain('第一章选中的片段')
    expect(req1Msgs[1]!.content).toContain('帮我检查这一页')

    // Turn-2 user message carries the new active page & selection
    expect(req2Msgs[3]!.role).toBe('user')
    expect(req2Msgs[3]!.content).toContain('EPUB/text/ch002.xhtml')
    expect(req2Msgs[3]!.content).toContain('第二章选中的片段')
    expect(req2Msgs[3]!.content).toContain('再看看这一页')
  })

  it('replays full tool-call/tool-result chains across providers, folds old large outputs, and annotates proposal outcomes', async () => {
    askRequests = []
    anthropicCapturedBodies = []
    const { archive } = openEpub(createEmptyEpub({ title: '跨协议记忆测试书' }), nodeXmlCodec.parse)

    const largeReadBody = '这是很长的旧章节内容。'.repeat(120)
    const oldTurnRead = {
      id: 'm1-a',
      role: 'assistant' as const,
      content: '已读取第一章。',
      proposalStatus: 'applied' as const,
      proposalResolution: { keptHunks: 2, totalHunks: 3, skippedPaths: ['EPUB/text/ch001.xhtml'] },
      steps: [
        { type: 'text' as const, text: '先读一下正文。' },
        {
          type: 'tool' as const,
          id: 't-old',
          callId: 'weird.call:id/with spaces',
          name: 'read_file' as const,
          args: { path: 'EPUB/text/ch001.xhtml', startLine: 1, endLine: 200 },
          argsSummary: 'EPUB/text/ch001.xhtml:1-200',
          ok: true,
          summary: '第 1–200 / 200 行',
          result: { ok: true, data: { content: largeReadBody, startLine: 1, endLine: 200, totalLines: 200 } },
        },
        { type: 'text' as const, text: '已读取第一章。' },
      ],
    }

    const recentTurnRead = {
      id: 'm4-a',
      role: 'assistant' as const,
      content: '已检查最新章节。',
      proposalStatus: 'reverted' as const,
      steps: [
        {
          type: 'tool' as const,
          id: 't-new',
          callId: 'call_recent_1',
          name: 'read_file' as const,
          args: { path: 'EPUB/text/ch001.xhtml', startLine: 1, endLine: 20 },
          argsSummary: 'EPUB/text/ch001.xhtml:1-20',
          ok: true,
          summary: '第 1–20 / 20 行',
          result: { ok: true, data: { content: '<p>最近保留的完整原文</p>', startLine: 1, endLine: 20, totalLines: 20 } },
        },
        { type: 'text' as const, text: '已检查最新章节。' },
      ],
    }

    // 4 prior logical turns so turn 1 is older than the newest 3 turns (gets folded) while turn 4 stays full.
    const history = [
      { id: 'm1-u', role: 'user' as const, content: '读第一章' },
      oldTurnRead,
      { id: 'm2-u', role: 'user' as const, content: '继续' },
      { id: 'm2-a', role: 'assistant' as const, content: '第二轮完成。' },
      { id: 'm3-u', role: 'user' as const, content: '再继续' },
      { id: 'm3-a', role: 'assistant' as const, content: '第三轮完成。' },
      { id: 'm4-u', role: 'user' as const, content: '再看一遍' },
      recentTurnRead,
    ]

    // Replay into Anthropic endpoint to verify normalized tool_use IDs and cross-provider compatibility!
    const res = await runAgentTurn({
      archive,
      provider: {
        provider: 'anthropic',
        baseUrl: `${mockUrl}/anthropic-replay/v1`,
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-mock',
      },
      history,
      userMessage: '把刚才那句改一下',
      approvalMode: 'ask',
      contextWindow: 200_000,
    })

    expect(res.error).toBeNull()
    expect(res.content).toBe('已衔接上一轮工具结果继续回复。')
    expect(res.usage.inputTokens).toBe(480)
    expect(anthropicCapturedBodies).toHaveLength(1)

    const serialized = JSON.stringify(anthropicCapturedBodies[0]!.messages)
    // Old large read_file output is folded (no raw 120x repetition), while recent read_file stays intact.
    expect(serialized).not.toContain('这是很长的旧章节内容。这是很长的旧章节内容。这是很长的旧章节内容。')
    expect(serialized).toContain('较早轮次的详细只读输出已折叠')
    expect(serialized).toContain('最近保留的完整原文')
    // Proposal annotations from applied (partial) and reverted turns are present.
    expect(serialized).toContain('保留 2/3 处变更')
    expect(serialized).toContain('撤销了本轮提案')
    // Normalized tool call id contains no dots/colons/slashes/spaces.
    expect(serialized).toContain('weird_call_id_with_spaces')
  })

  it('auto-compacts at 80% context window and gracefully degrades when compaction fails', async () => {
    askRequests = []
    compactCalls = 0
    compactFailMode = false
    const { archive } = openEpub(createEmptyEpub({ title: '自动压缩测试书' }), nodeXmlCodec.parse)

    const longHistory = [
      { id: 'u1', role: 'user' as const, content: '第一轮请核对全书术语规范：'.concat('学术术语记录。'.repeat(180)) },
      { id: 'a1', role: 'assistant' as const, content: '已核对并记录了术语列表：'.concat('条目详情。'.repeat(180)) },
      { id: 'u2', role: 'user' as const, content: '第二轮请检查标点：'.concat('标点详情。'.repeat(180)) },
      { id: 'a2', role: 'assistant' as const, content: '第二轮已完成标点检查：'.concat('检查结论。'.repeat(180)) },
      { id: 'u3', role: 'user' as const, content: '第三轮看看目录' },
      { id: 'a3', role: 'assistant' as const, content: '目录结构正常。' },
    ]

    const events: AgentStreamEvent[] = []
    const compactedRes = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/ask-check/v1`,
        model: 'mock-ask',
        apiKey: null,
      },
      history: longHistory,
      userMessage: '继续第四轮校对',
      approvalMode: 'ask',
      contextWindow: 4_096,
      onEvent: (event) => events.push(event),
    })

    expect(compactedRes.error).toBeNull()
    expect(compactCalls).toBe(1)
    expect(compactedRes.compaction).not.toBeNull()
    expect(compactedRes.compaction!.summary).toContain('【压缩摘要】')
    expect(compactedRes.compaction!.compactedUpToMessageId).toBeTruthy()
    expect(events.some((e) => e.type === 'compacted')).toBe(true)
    expect(events.some((e) => e.type === 'usage')).toBe(true)

    const streamingReq = askRequests.find((r) => r.stream === true)!
    const sentMessages = streamingReq.messages as Array<{ role: string; content: string }>
    expect(JSON.stringify(sentMessages)).toContain('<session_compaction_summary>')
    expect(JSON.stringify(sentMessages)).toContain('【压缩摘要】')

    // Now simulate compaction endpoint failure -> must gracefully degrade and still answer!
    askRequests = []
    compactFailMode = true
    const degradedEvents: AgentStreamEvent[] = []
    const degradedRes = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/ask-check/v1`,
        model: 'mock-ask',
        apiKey: null,
      },
      history: longHistory,
      userMessage: '即使压缩失败也继续回答',
      approvalMode: 'ask',
      contextWindow: 4_096,
      onEvent: (event) => degradedEvents.push(event),
    })

    compactFailMode = false
    expect(degradedRes.error).toBeNull()
    expect(degradedRes.content).toBe('仅给出只读校对建议。')
    expect(degradedRes.compaction?.notice.degraded).toBe(true)
    expect(degradedEvents.some((e) => e.type === 'compacted' && e.notice.degraded === true)).toBe(true)
  })

  it('preserves completed write tool edits on soft-stop in review mode while discarding them in auto mode', async () => {
    const { archive } = openEpub(createEmptyEpub({ title: '中止保留测试书' }), nodeXmlCodec.parse)

    // Review mode: abort right after the successful second edit_file -> preserves partial validated proposal
    openAiStep = 0
    const reviewAc = new AbortController()
    const reviewEvents: AgentStreamEvent[] = []
    const reviewRes = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/openai/v1`,
        model: 'mock-oai',
        apiKey: 'sk-test',
      },
      history: [],
      userMessage: '校对第一章后停止',
      approvalMode: 'review',
      abortSignal: reviewAc.signal,
      onEvent: (event) => {
        reviewEvents.push(event)
        if (event.type === 'proposal_update') reviewAc.abort()
      },
    })
    expect(reviewRes.stopped).toBe(true)
    expect(reviewRes.proposal).not.toBeNull()
    expect(reviewRes.proposal!.files[0]?.afterText).toContain('已经校对完成的正文。')
    expect(reviewEvents.some((e) => e.type === 'proposal_update')).toBe(true)
    expect(reviewEvents.some((e) => e.type === 'proposal')).toBe(true)
    expect(reviewEvents.at(-1)).toEqual({ type: 'done', stopped: true })

    // Auto mode: abort right after successful edit_file -> discards partial proposal
    openAiStep = 0
    const autoAc = new AbortController()
    const autoEvents: AgentStreamEvent[] = []
    const autoRes = await runAgentTurn({
      archive,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/openai/v1`,
        model: 'mock-oai',
        apiKey: 'sk-test',
      },
      history: [],
      userMessage: '自动校对后停止',
      approvalMode: 'auto',
      abortSignal: autoAc.signal,
      onEvent: (event) => {
        autoEvents.push(event)
        if (event.type === 'tool_end' && event.ok) autoAc.abort()
      },
    })
    expect(autoRes.stopped).toBe(true)
    expect(autoRes.proposal).toBeNull()
    expect(autoEvents.some((e) => e.type === 'proposal')).toBe(false)
  })

  it('lazy-loads raster images for inspect_image across OpenAI-compatible & Anthropic while omitting base64 from persisted steps', async () => {
    const { archive } = openEpub(createEmptyEpub({ title: '读图测试书' }), nodeXmlCodec.parse)
    const pngBytes = new Uint8Array(24)
    pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    pngBytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
    const view = new DataView(pngBytes.buffer)
    view.setUint32(16, 120, false)
    view.setUint32(20, 80, false)
    const expectedBase64 = Buffer.from(pngBytes).toString('base64')

    // Simulate listWorkspaceEntries omitting binary bytes while supplying real entrySizes
    archive.entries.set('EPUB/images/chart.png', new Uint8Array(0))
    archive.order.push('EPUB/images/chart.png')
    const opf = new TextDecoder().decode(archive.entries.get('EPUB/content.opf')!)
    archive.entries.set(
      'EPUB/content.opf',
      new TextEncoder().encode(
        opf.replace('</manifest>', '  <item id="chart" href="images/chart.png" media-type="image/png"/>\n  </manifest>'),
      ),
    )

    let loadCalls = 0
    const loadBinary = async (path: string) => {
      loadCalls += 1
      return path === 'EPUB/images/chart.png' ? pngBytes : null
    }
    const entrySizes = new Map([['EPUB/images/chart.png', pngBytes.byteLength]])

    // 1. OpenAI-compatible vision tool result
    oaiImageStep = 0
    oaiImageBodies = []
    const oaiRes = await runAgentTurn({
      archive,
      entrySizes,
      loadBinary,
      provider: {
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/openai-image/v1`,
        model: 'gpt-4o',
        apiKey: 'sk-test',
      },
      history: [],
      userMessage: '看看 EPUB/images/chart.png 是什么图',
      approvalMode: 'ask',
    })
    expect(oaiRes.error).toBeNull()
    expect(oaiRes.content).toBe('图表为 120×80 PNG。')
    expect(loadCalls).toBe(1)
    expect(oaiImageBodies).toHaveLength(2)
    const oaiStep2Messages = oaiImageBodies[1]!.messages as Array<{ role: string; content: unknown }>
    const oaiToolMsg = oaiStep2Messages.find((m) => m.role === 'tool')!
    expect(Array.isArray(oaiToolMsg.content)).toBe(true)
    const oaiParts = oaiToolMsg.content as Array<{ type: string; image_url?: { url: string } }>
    expect(oaiParts.some((p) => p.type === 'image_url' && p.image_url?.url === `data:image/png;base64,${expectedBase64}`)).toBe(true)
    // Persisted step JSON must NEVER contain base64 image data
    expect(JSON.stringify(oaiRes.steps)).not.toContain(expectedBase64)
    expect(JSON.stringify(oaiRes.steps)).toContain('"width":120')

    // 2. Anthropic vision tool result
    anthImageStep = 0
    anthImageBodies = []
    const anthRes = await runAgentTurn({
      archive,
      entrySizes,
      loadBinary,
      provider: {
        provider: 'anthropic',
        baseUrl: `${mockUrl}/anthropic-image/v1`,
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-ant-mock',
      },
      history: [],
      userMessage: '帮我写 chart.png 的 alt',
      approvalMode: 'ask',
    })
    expect(anthRes.error).toBeNull()
    expect(anthRes.content).toBe('已识别图表内容。')
    expect(loadCalls).toBe(2)
    expect(anthImageBodies).toHaveLength(2)
    const anthSerialized = JSON.stringify(anthImageBodies[1]!.messages)
    expect(anthSerialized).toContain('"type":"image"')
    expect(anthSerialized).toContain(expectedBase64)
    expect(JSON.stringify(anthRes.steps)).not.toContain(expectedBase64)
  })
})
