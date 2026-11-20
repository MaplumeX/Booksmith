import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createEmptyEpub, openEpub, zipArchive } from '@booksmith/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeXmlCodec } from '../src/agent/nodeXmlCodec'
import { testProfileConnection, validateBaseUrl } from '../src/agent/providers'
import { runAgentTurn, trimHistory, type AgentStreamEvent } from '../src/agent/runner'
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
        req.on('close', () => clearTimeout(timer))
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
    expect(events.some((e) => e.type === 'proposal')).toBe(true)
    expect(events.at(-1)?.type).toBe('done')
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
})
