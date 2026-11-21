import { expect, request as playwrightRequest, test } from '@playwright/test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { API, E2E_EMAIL, E2E_PASSWORD, expectLoggedIn, login, seedBook } from './helpers'

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
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

async function resetAgentState(): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: API })
  await ctx.post('/api/auth/login', { data: { email: E2E_EMAIL, password: E2E_PASSWORD } })
  const res = await ctx.get('/api/agent/profiles')
  if (res.ok()) {
    const body = (await res.json()) as { profiles: Array<{ id: string }> }
    for (const p of body.profiles) await ctx.delete(`/api/agent/profiles/${p.id}`)
  }
  await ctx.patch('/api/agent/settings', {
    data: { defaultApprovalMode: 'review', maxSteps: 15, customInstructions: '' },
  })
  await ctx.dispose()
}

let mockServer: ReturnType<typeof createServer>
let mockUrl = ''
let mode:
  | 'proofread'
  | 'chapter'
  | 'css-edit'
  | 'ask-reasoning'
  | 'multi-reasoning'
  | 'auto-edit'
  | 'retry-fail'
  | 'retry-ok'
  | 'continuity-t1'
  | 'continuity-t2'
  | 'continuity-t3'
  | 'live-stream'
  | 'live-soft-stop'
  | 'quote-review' = 'proofread'
let turnStep = 0
let releaseSecondReasoning: (() => void) | null = null
let secondReasoningFlushed: (() => void) | null = null
let releaseLiveStep2: (() => void) | null = null
let liveStep2Entered: (() => void) | null = null
let releaseLiveStep3: (() => void) | null = null
let liveStep3Entered: (() => void) | null = null
let liveStopStep2Entered: (() => void) | null = null
let lastModelSeen = ''
let lastToolCountSeen = 0
let lastSystemPromptSeen = ''
let lastMessagesSeen: Array<Record<string, unknown>> = []
let compactionRequestsSeen = 0

test.beforeAll(async () => {
  mockServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const bodyText = await readBody(req)
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-fast' }, { id: 'mock-pro' }, { id: 'mock-reasoner' }],
        }),
      )
      return
    }

    if (url.pathname === '/v1/chat/completions') {
      lastModelSeen = typeof body.model === 'string' ? body.model : ''
      lastToolCountSeen = Array.isArray(body.tools) ? body.tools.length : 0
      const msgs = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: string }>) : []
      lastSystemPromptSeen = msgs.find((m) => m.role === 'system')?.content ?? ''
      if (body.stream === true) {
        lastMessagesSeen = msgs as Array<Record<string, unknown>>
      }

      if (body.stream !== true) {
        const isCompaction = msgs.some(
          (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('上下文压缩器'),
        )
        if (isCompaction) {
          compactionRequestsSeen += 1
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: `cmp-${compactionRequestsSeen}`,
              object: 'chat.completion',
              created: 1,
              model: body.model ?? 'mock',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: '【E2E自动摘要】前两轮已连续修改第一章两处段落并保持术语统一。',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 180, completion_tokens: 40, total_tokens: 220 },
            }),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'ping',
            object: 'chat.completion',
            created: 1,
            model: body.model ?? 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          }),
        )
        return
      }

      if (mode === 'live-stream') {
        turnStep += 1
        if (turnStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'ls-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_ls_1',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<p>中间保持原样的段落</p>',
                            newText: '<p>实时第一步已校对</p>',
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
              id: 'ls-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        if (turnStep === 2) {
          liveStep2Entered?.()
          await new Promise<void>((resolve) => {
            releaseLiveStep2 = resolve
          })
          writeOpenAiSse(res, [
            {
              id: 'ls-2',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_ls_2a',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<p>首段待校对</p>',
                            newText: '<p>首段实时新增改动</p>',
                          }),
                        },
                      },
                      {
                        index: 1,
                        id: 'call_ls_2b',
                        type: 'function',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/styles/stylesheet1.css',
                            content: 'body { line-height: 1.9; }\n',
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
              id: 'ls-2',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        liveStep3Entered?.()
        await new Promise<void>((resolve) => {
          releaseLiveStep3 = resolve
        })
        writeOpenAiSse(res, [
          {
            id: 'ls-3',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-fast',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '实时多步校对已完成，请确认最终应用。' },
                finish_reason: 'stop',
              },
            ],
          },
        ])
        return
      }

      if (mode === 'live-soft-stop') {
        turnStep += 1
        if (turnStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'lss-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_lss_1',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<p>第三段待停止测试</p>',
                            newText: '<p>停止前已完成的修改</p>',
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
              id: 'lss-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.flushHeaders?.()
        liveStopStep2Entered?.()
        const ping = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n')
        }, 50)
        req.on('close', () => {
          clearInterval(ping)
          if (!res.writableEnded) res.end()
        })
        return
      }

      if (mode === 'continuity-t1') {
        turnStep += 1
        if (turnStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'ct1-a',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: '先定位并修改第一处。',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_e2e_ct1',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<p>从这里开始写。</p>',
                            newText: '<p>第一处已润色。</p>\n<p>第二处待润色。</p>',
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
              id: 'ct1-a',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        writeOpenAiSse(res, [
          {
            id: 'ct1-b',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-fast',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '第一轮润色已完成，可先审阅或直接继续微调。' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1400, completion_tokens: 24, total_tokens: 1424 },
          },
        ])
        return
      }

      if (mode === 'continuity-t2') {
        turnStep += 1
        if (turnStep === 1) {
          await new Promise((r) => setTimeout(r, 350))
          writeOpenAiSse(res, [
            {
              id: 'ct2-a',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_e2e_ct2',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<p>第二处待润色。</p>',
                            newText: '<p>第二处也已顺带润色。</p>',
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
              id: 'ct2-a',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-fast',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        writeOpenAiSse(res, [
          {
            id: 'ct2-b',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-fast',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '已在原待审阅草稿上叠加修改第二处。' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 3400, completion_tokens: 20, total_tokens: 3420 },
          },
        ])
        return
      }

      if (mode === 'continuity-t3') {
        writeOpenAiSse(res, [
          {
            id: 'ct3',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-fast',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '已基于自动压缩摘要继续协助。' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1100, completion_tokens: 18, total_tokens: 1118 },
          },
        ])
        return
      }

      if (mode === 'retry-fail') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid key' } }))
        return
      }

      if (mode === 'retry-ok') {
        writeOpenAiSse(res, [
          {
            id: 'rt-ok',
            object: 'chat.completion.chunk',
            created: 1,
            model: lastModelSeen || 'mock-pro',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: `已通过 ${lastModelSeen} 重试成功。` },
                finish_reason: 'stop',
              },
            ],
          },
        ])
        return
      }

      if (mode === 'quote-review') {
        turnStep += 1
        if (turnStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'qr-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: lastModelSeen || 'mock-fast',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_qr_wrap',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<p>待包裹引文一</p>\n<p>待包裹引文二</p>',
                            newText: '<blockquote>\n<p>待包裹引文一</p>\n<p>待包裹引文二</p>\n</blockquote>',
                          }),
                        },
                      },
                      {
                        index: 1,
                        id: 'call_qr_typo',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '<blockquote><p>已有引文错字示例</p></blockquote>',
                            newText: '<blockquote><p>已有引文正字示例</p></blockquote>',
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
              id: 'qr-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: lastModelSeen || 'mock-fast',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        writeOpenAiSse(res, [
          {
            id: 'qr-2',
            object: 'chat.completion.chunk',
            created: 1,
            model: lastModelSeen || 'mock-fast',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '已将两段引文包裹为引用块，并修正已有引用中的错字。' },
                finish_reason: 'stop',
              },
            ],
          },
        ])
        return
      }

      if (mode === 'multi-reasoning') {
        turnStep += 1
        if (turnStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'mr-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: lastModelSeen || 'mock-reasoner',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    reasoning_content: '第一阶段思考：读取第一章确认错字位置。',
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'mr-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: lastModelSeen || 'mock-reasoner',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_mr_read',
                        type: 'function',
                        function: {
                          name: 'read_file',
                          arguments: JSON.stringify({ path: 'EPUB/text/ch001.xhtml' }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'mr-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: lastModelSeen || 'mock-reasoner',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }

        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.write(
          `data: ${JSON.stringify({
            id: 'mr-2',
            object: 'chat.completion.chunk',
            created: 1,
            model: lastModelSeen || 'mock-reasoner',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  reasoning_content: '第二阶段思考：已确认内容，准备整理最终回复。',
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        )
        secondReasoningFlushed?.()
        await new Promise<void>((resolve) => {
          releaseSecondReasoning = resolve
        })
        res.write(
          `data: ${JSON.stringify({
            id: 'mr-2',
            object: 'chat.completion.chunk',
            created: 1,
            model: lastModelSeen || 'mock-reasoner',
            choices: [
              {
                index: 0,
                delta: { content: '双阶段推理完成：第一章结构正常。' },
                finish_reason: 'stop',
              },
            ],
          })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (mode === 'ask-reasoning') {
        writeOpenAiSse(res, [
          {
            id: 'ask-r1',
            object: 'chat.completion.chunk',
            created: 1,
            model: lastModelSeen || 'mock-reasoner',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', reasoning_content: '核对只读权限边界与自定义学术校对指令。' },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'ask-r1',
            object: 'chat.completion.chunk',
            created: 1,
            model: lastModelSeen || 'mock-reasoner',
            choices: [
              {
                index: 0,
                delta: { content: '只读顾问回复：建议统一全角引号。' },
                finish_reason: 'stop',
              },
            ],
          },
        ])
        return
      }

      turnStep += 1
      if (mode === 'auto-edit') {
        if (turnStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'a1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-pro',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_auto_1',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '未保存测试错字',
                            newText: '自动模式修正文本',
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
              id: 'a1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-pro',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        writeOpenAiSse(res, [
          {
            id: 'a2',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock-pro',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '已按自动模式完成章节错字修正。' },
                finish_reason: 'stop',
              },
            ],
          },
        ])
        return
      }

      if (mode === 'css-edit') {
        if (turnStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'css1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_css_1',
                        type: 'function',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/styles/stylesheet1.css',
                            content: 'body { line-height: 1.85; }\np { text-indent: 2em; }\n',
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
              id: 'css1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        writeOpenAiSse(res, [
          {
            id: 'css2',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '已调整全书样式表行高与段首缩进。' },
                finish_reason: 'stop',
              },
            ],
          },
        ])
        return
      }

      if (mode === 'proofread') {
        if (turnStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 'p1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_edit_1',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '未保存测试错字',
                            newText: '已校对正确文本',
                          }),
                        },
                      },
                      {
                        index: 1,
                        id: 'call_edit_2',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '第二处待定措辞',
                            newText: '第二处改写措辞',
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
              id: 'p1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            },
          ])
          return
        }
        writeOpenAiSse(res, [
          {
            id: 'p2',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: '已定位并修正 **未保存草稿** 中的两处文本（`ch001.xhtml`）。',
                },
                finish_reason: 'stop',
              },
            ],
          },
        ])
        return
      }

      // Structural mode: create_chapter
      if (turnStep === 1) {
        writeOpenAiSse(res, [
          {
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_create_1',
                      type: 'function',
                      function: {
                        name: 'create_chapter',
                        arguments: JSON.stringify({
                          filename: 'afterword.xhtml',
                          title: '后记',
                          addToToc: true,
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
            model: 'mock',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          },
        ])
        return
      }
      writeOpenAiSse(res, [
        {
          id: 'c2',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '已生成「后记」章节并同步加入目录。' },
              finish_reason: 'stop',
            },
          ],
        },
      ])
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

test.afterAll(async () => {
  await resetAgentState()
  await new Promise<void>((resolve) => mockServer.close(() => resolve()))
})

test('multi-model provider fetch, approval modes (ask/review/auto), reasoning, cloud prefs, and last-turn retry', async ({
  page,
}) => {
  const bookId = await seedBook()
  await resetAgentState()

  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await page.waitForSelector('.cm-content')

  // Open dedicated Agent sidebar via topbar toggle button (no 6th tab)
  await expect(page.getByRole('tab', { name: '助手' })).toHaveCount(0)
  await page.getByRole('button', { name: '助手' }).click()
  await expect(page.getByText('配置模型以启用助手')).toBeVisible()

  // Configure cloud runtime preferences + single provider with multiple models fetched from /v1/models
  await page.getByRole('button', { name: '配置模型预设' }).click()
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('tab', { name: 'AI 助手' })).toHaveAttribute('aria-selected', 'true')

  // Adjust cloud preferences (free-input max steps > 30 + custom instructions)
  await dialog.getByTestId('agent-max-steps-input').fill('80')
  await expect(dialog.getByTestId('agent-max-steps-input')).toHaveValue('80')
  await dialog.getByLabel(/自定义附加指令/).fill('校对时保留原文学术术语。')
  await dialog.getByRole('button', { name: '保存偏好' }).click()
  await expect(dialog.getByText('运行偏好已同步保存')).toBeVisible()

  // Configure provider once and fetch multiple models under the same API key
  await dialog.getByLabel('预设名称').fill('统一中转')
  await dialog.getByLabel('Base URL').fill(`${mockUrl}/v1`)
  await dialog.getByLabel('模型名称').fill('mock-fast')
  await dialog.getByLabel('API Key（本地模型可留空）').fill('sk-e2e-secret-9999')

  await dialog.getByRole('button', { name: '拉取模型列表' }).click()
  await expect(dialog.getByRole('button', { name: 'mock-pro' })).toBeVisible()
  await dialog.getByRole('button', { name: 'mock-pro' }).click()
  await dialog.getByRole('button', { name: 'mock-reasoner' }).click()

  await dialog.getByRole('button', { name: '测试连接' }).click()
  await expect(dialog.getByText(/连接成功/)).toBeVisible()

  await dialog.getByRole('button', { name: '添加预设' }).click()
  await expect(dialog.getByText('预设已保存')).toBeVisible()
  await expect(dialog.locator('.agent-profile-model-count')).toHaveText('+2')

  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toBeHidden()

  // Open ch001.xhtml and make an unsaved edit with two distinct paragraphs & linked stylesheet
  await page.getByRole('button', { name: 'ch001.xhtml', exact: true }).click()
  const docWithTypo = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '<head><title>第一章</title><link rel="stylesheet" type="text/css" href="../styles/stylesheet1.css" /></head>',
    '<body>',
    '<p>未保存测试错字</p>',
    '<p>中间保持原样的段落</p>',
    '<p>第二处待定措辞</p>',
    '</body>',
    '</html>',
  ].join('\n')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(docWithTypo)
  await expect(page.locator('.cm-content')).toContainText('未保存测试错字')

  // Verify context chip can be dismissed and re-attached cleanly
  await page.getByRole('button', { name: '移除当前文件上下文' }).click()
  await page.getByRole('button', { name: '重新挂载当前文件上下文' }).click()
  await expect(page.locator('.agent-context-chip')).toContainText('ch001.xhtml')

  // Turn 1: switch to same-provider `mock-reasoner` + `ask` (read-only) mode -> reasoning block & 7 tools & custom prompt
  await page.getByRole('button', { name: '切换审批模式' }).click()
  await page.getByRole('menuitemradio', { name: /只读/ }).click()
  await page.getByRole('button', { name: '选择模型预设' }).click()
  await page.getByRole('menuitemradio', { name: 'mock-reasoner' }).click()

  mode = 'ask-reasoning'
  await page.getByLabel('向助手输入指令').fill('只读检查一下引号')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('只读顾问回复：建议统一全角引号。')).toBeVisible()
  expect(lastModelSeen).toBe('mock-reasoner')
  expect(lastToolCountSeen).toBe(7)
  expect(lastSystemPromptSeen).toContain('校对时保留原文学术术语。')

  // Expand collapsed process drawer, then open the reasoning step inside it
  const turn1Drawer = page.getByTestId('agent-process-drawer').last()
  await expect(turn1Drawer.getByTestId('agent-process-timeline')).toHaveCount(0)
  await turn1Drawer.getByTestId('agent-process-toggle').click()
  await turn1Drawer.getByRole('button', { name: /思考过程/ }).click()
  await expect(page.getByText('核对只读权限边界与自定义学术校对指令。')).toBeVisible()

  // Turn 2: switch to `auto` mode + same-provider `mock-pro` -> auto-applies to workspace with undo button
  await page.getByRole('button', { name: '切换审批模式' }).click()
  await page.getByRole('menuitemradio', { name: /自动/ }).click()
  await expect(page.locator('.agent-mode-trigger.is-auto')).toBeVisible()

  await page.getByRole('button', { name: '选择模型预设' }).click()
  await page.getByRole('menuitemradio', { name: 'mock-pro' }).click()

  mode = 'auto-edit'
  turnStep = 0
  await page.getByLabel('向助手输入指令').fill('自动修正未保存的错字')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('已自动应用到工作区（1 个文件）')).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('自动模式修正文本')
  expect(lastModelSeen).toBe('mock-pro')
  expect(lastToolCountSeen).toBe(21)

  // Retry button is disabled on applied proposal turn
  await expect(page.getByRole('button', { name: '重试此回复' })).toBeDisabled()

  // Undo restores original unsaved text; applied card also supports read-only replay in main canvas
  await page.getByRole('button', { name: '查看改动' }).click()
  const reviewPane = page.locator('.review-pane')
  await expect(reviewPane).toBeVisible()
  await expect(reviewPane.getByText('已应用回看')).toBeVisible()
  await reviewPane.getByRole('button', { name: '退出回看' }).click()
  await expect(reviewPane).toBeHidden()

  await page.getByRole('button', { name: '撤销本次应用' }).click()
  await expect(page.locator('.cm-content')).toContainText('未保存测试错字')

  // Turn 3: review mode automatically opens main-canvas book-page revision view with per-hunk skipping
  await page.getByRole('button', { name: '切换审批模式' }).click()
  await page.getByRole('menuitemradio', { name: /审阅/ }).click()

  mode = 'proofread'
  turnStep = 0
  await page.getByLabel('向助手输入指令').fill('审阅修正两处错字')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.locator('.agent-reply .agent-md strong')).toContainText('未保存草稿')
  // Sidebar card is slimmed down (no embedded code diff) and highlights active review
  await expect(page.locator('.agent-proposal-diff')).toHaveCount(0)
  await expect(page.locator('.agent-proposal-card.is-reviewing')).toBeVisible()
  // Left file tree shows pending review badge for ch001.xhtml
  await expect(page.locator('.tree-review-badge.is-update')).toHaveText('改')

  // Main canvas renders book-page "修订" view with inline del/ins inside the iframe
  await expect(reviewPane).toBeVisible()
  const revFrame = reviewPane.frameLocator('.review-book-frame')
  await expect(revFrame.locator('.bs-rev-ins').first()).toContainText('已校对正确文本')
  await expect(revFrame.locator('.bs-rev-del').first()).toContainText('未保存测试错字')

  // Accept the 1st hunk (collapses diff highlight in-place) and reject the 2nd hunk directly inside the book-page revision view
  await revFrame.locator('[data-bs-action="accept-hunk"][data-bs-target-hunk="hunk-0"]').click()
  await expect(revFrame.locator('[data-bs-hunk="hunk-0"]')).toHaveAttribute('data-bs-rev', 'accepted')
  await expect(revFrame.locator('[data-bs-hunk="hunk-0"]')).toContainText('已校对正确文本')
  await expect(revFrame.locator('[data-bs-hunk="hunk-0"] .bs-rev-del')).toHaveCount(0)

  await revFrame.locator('[data-bs-action="reject-hunk"][data-bs-target-hunk="hunk-1"]').click()
  await expect(revFrame.locator('[data-bs-hunk="hunk-1"]')).toHaveAttribute('data-bs-rev', 'rejected')
  await expect(revFrame.locator('[data-bs-hunk="hunk-1"]')).toContainText('第二处待定措辞')
  await expect(reviewPane.getByRole('button', { name: '应用已选（1/2 处）' })).toBeVisible()

  // Switch to "终稿" view and verify rejected hunk stays original while accepted hunk is updated
  await reviewPane.getByRole('button', { name: '终稿' }).click()
  const finalFrame = reviewPane.frameLocator('.review-book-frame')
  await expect(finalFrame.locator('body')).toContainText('已校对正确文本')
  await expect(finalFrame.locator('body')).toContainText('第二处待定措辞')
  await expect(finalFrame.locator('body')).not.toContainText('第二处改写措辞')

  // Switch to "源码" view and verify line numbers & shared 3-state accepted/rejected hunk states
  await reviewPane.getByRole('button', { name: '源码' }).click()
  await expect(reviewPane.locator('.review-src-hunk')).toHaveCount(2)
  await expect(reviewPane.locator('.review-src-hunk.is-accepted')).toHaveCount(1)
  await expect(reviewPane.locator('.review-src-hunk.is-rejected')).toHaveCount(1)

  // Exit review and re-enter via sidebar card: skipped hunk draft is preserved in memory
  await reviewPane.getByRole('button', { name: '退出审阅' }).click()
  await expect(reviewPane).toBeHidden()
  await page.getByRole('button', { name: '审阅变更' }).click()
  await expect(reviewPane).toBeVisible()
  await expect(reviewPane.getByRole('button', { name: '应用已选（1/2 处）' })).toBeVisible()

  // Apply only kept hunk -> editor receives kept change while skipped paragraph stays intact
  await reviewPane.getByRole('button', { name: '应用已选（1/2 处）' }).click()
  await expect(reviewPane).toBeHidden()
  await expect(page.locator('.cm-content')).toContainText('已校对正确文本')
  await expect(page.locator('.cm-content')).toContainText('第二处待定措辞')
  await expect(page.locator('.cm-content')).not.toContainText('第二处改写措辞')

  // Turn 3b: CSS edit proposal offers linked chapter final-style preview with before/after toggle
  mode = 'css-edit'
  turnStep = 0
  await page.getByLabel('向助手输入指令').fill('优化样式表行高')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(reviewPane).toBeVisible()
  await expect(reviewPane.getByRole('button', { name: /在引用章节终稿中预览样式/ })).toBeVisible()
  await reviewPane.getByRole('button', { name: /在引用章节终稿中预览样式/ }).click()
  await expect(reviewPane.getByRole('button', { name: '修改后样式' })).toHaveAttribute('aria-pressed', 'true')
  await reviewPane.getByRole('button', { name: '修改前样式' }).click()
  await expect(reviewPane.getByRole('button', { name: '修改前样式' })).toHaveAttribute('aria-pressed', 'true')
  await reviewPane.getByRole('button', { name: '返回样式源码' }).click()
  await reviewPane.getByRole('button', { name: '放弃' }).click()
  await expect(reviewPane).toBeHidden()

  // Turn 3c: Structural proposal shows top structural summary strip and applies atomically
  mode = 'chapter'
  turnStep = 0
  await page.getByLabel('向助手输入指令').fill('新增一章后记并加入目录')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(reviewPane).toBeVisible()
  await expect(reviewPane.locator('.review-context-strip.is-structural')).toContainText('新增 1 章')
  await reviewPane.getByRole('button', { name: '应用全部变更' }).click()
  await expect(reviewPane).toBeHidden()
  await expect(page.getByRole('button', { name: 'afterword.xhtml', exact: true })).toBeVisible()

  // Turn 4: failed turn -> switch model and retry in place without duplicating user bubbles
  mode = 'retry-fail'
  await page.getByLabel('向助手输入指令').fill('测试失败重试')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText(/模型鉴权失败/)).toBeVisible()

  const userTurnsBefore = await page.locator('.agent-turn.is-user').count()
  await page.getByRole('button', { name: '选择模型预设' }).click()
  await page.getByRole('menuitemradio', { name: 'mock-fast' }).click()
  mode = 'retry-ok'
  await page.getByRole('button', { name: '重试此回复' }).click()
  await expect(page.getByText('已通过 mock-fast 重试成功。')).toBeVisible()
  expect(await page.locator('.agent-turn.is-user').count()).toBe(userTurnsBefore)

  // Rename thread inside Radix history Popover and verify persistence across reload
  await page.getByRole('button', { name: '切换历史对话' }).click()
  await page.locator('.agent-history-row-actions button').first().click()
  await page.getByLabel('输入新对话标题').fill('第一章校对记录')
  await page.getByRole('button', { name: '保存标题' }).click()
  await expect(page.locator('.agent-thread-trigger-title')).toHaveText('第一章校对记录')
  await page.keyboard.press('Escape')

  // Reload page and confirm thread title, model, approvalMode, reasoning & retried reply persisted
  await page.reload()
  await page.waitForSelector('.cm-content')
  await page.getByRole('button', { name: '助手' }).click()
  await expect(page.locator('.agent-thread-trigger-title')).toHaveText('第一章校对记录')
  await expect(page.locator('.agent-model-trigger-name')).toHaveText('mock-fast')
  await expect(page.getByText('已通过 mock-fast 重试成功。')).toBeVisible()

  // Check zero horizontal overflow at 1440px and 400px mobile viewport
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(desktopOverflow).toBe(0)

  await page.setViewportSize({ width: 400, height: 860 })
  await page.waitForTimeout(200)
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(mobileOverflow).toBe(0)

  // Closing the Agent sidebar at 400px closes the drawer cleanly
  await page.getByRole('button', { name: '关闭助手栏' }).click()
  await expect(page.locator('.sidebar')).toBeHidden()
})

test('continuous Agent session: keep-alive collapse, interleaved timeline, cumulative pending proposals, and 80% auto-compaction', async ({
  page,
}) => {
  const bookId = await seedBook()
  await resetAgentState()
  compactionRequestsSeen = 0
  lastMessagesSeen = []

  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await page.waitForSelector('.cm-content')

  // Open Agent sidebar and create a profile with an explicit 4096 contextWindow override
  await page.getByRole('button', { name: '助手' }).click()
  await page.getByRole('button', { name: '配置模型预设' }).click()
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await dialog.getByLabel('预设名称').fill('连续会话测试')
  await dialog.getByLabel('Base URL').fill(`${mockUrl}/v1`)
  await dialog.getByLabel('模型名称').fill('mock-fast')
  await dialog.getByTestId('agent-context-window-input').fill('4096')
  await dialog.getByRole('button', { name: '添加预设' }).click()
  await expect(dialog.getByText('预设已保存')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  // Open ch001.xhtml and seed known text so Turn 1 & Turn 2 edit_file calls match deterministically
  await page.getByRole('button', { name: 'ch001.xhtml', exact: true }).click()
  const baseChapter = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '<head><title>第一章</title></head>',
    '<body>',
    '<p>从这里开始写。</p>',
    '</body>',
    '</html>',
  ].join('\n')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(baseChapter)
  await expect(page.locator('.cm-content')).toContainText('从这里开始写。')

  // Select text inside the live book Preview iframe -> Agent selection chip captures snippet & sends it in context
  const previewFrame = page.locator('.preview-card iframe').contentFrame()
  const previewParagraph = previewFrame.getByText('从这里开始写。')
  await expect(previewParagraph).toBeVisible()
  await previewParagraph.evaluate((el) => {
    const doc = el.ownerDocument
    const range = doc.createRange()
    range.selectNodeContents(el)
    const sel = doc.defaultView?.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    doc.dispatchEvent(new Event('selectionchange'))
  })
  await expect(page.getByTestId('agent-selection-chip')).toContainText('从这里开始写。')

  // Turn 1: interleaved timeline (text -> tool -> text) + context usage pill + pending proposal
  mode = 'continuity-t1'
  turnStep = 0
  await page.getByLabel('向助手输入指令').fill('先润色第一章第一句')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('第一轮润色已完成，可先审阅或直接继续微调。')).toBeVisible()
  expect(JSON.stringify(lastMessagesSeen)).toContain('从这里开始写。')
  // Intermediate commentary & tool calls stay collapsed inside the single process drawer; only final reply renders outside
  await expect(page.locator('.agent-turn.is-assistant .agent-reply')).toHaveCount(1)
  await expect(page.getByText('先定位并修改第一处。')).toBeHidden()
  await page.getByTestId('agent-process-toggle').first().click()
  await expect(page.getByTestId('agent-process-note')).toContainText('先定位并修改第一处。')
  await expect(page.getByTestId('agent-process-tool')).toHaveCount(1)
  await expect(page.getByTestId('agent-context-usage')).toHaveText('34%')

  // Exit main-canvas review without applying, then send Turn 2 while collapsing sidebar mid-stream
  const reviewPane = page.locator('.review-pane')
  await expect(reviewPane).toBeVisible()
  await reviewPane.getByRole('button', { name: '退出审阅' }).click()

  mode = 'continuity-t2'
  turnStep = 0
  const textarea = page.getByLabel('向助手输入指令')
  await textarea.fill('顺便把第二处也润色了')
  await page.getByRole('button', { name: '发送' }).click()

  // While streaming: textarea stays editable for drafting, and collapsing sidebar does NOT abort the stream!
  await textarea.fill('提前起草的下一句草稿')
  await expect(textarea).toHaveValue('提前起草的下一句草稿')
  await page.getByRole('button', { name: '关闭助手栏' }).click()
  await expect(page.locator('.sidebar.is-agent')).toBeHidden()

  // Wait for background stream to finish and automatically open the cumulative proposal review
  await expect(reviewPane).toBeVisible()
  await page.getByRole('button', { name: '助手' }).click()
  await expect(page.getByText('已在原待审阅草稿上叠加修改第二处。')).toBeVisible()
  // Draft typed during streaming and old proposal superseded state are preserved!
  await expect(textarea).toHaveValue('提前起草的下一句草稿')
  await expect(page.getByText('已被后续修改替代（1 个文件）')).toBeVisible()
  // Usage pill updated to 83% and enters warn state (>= 70%)
  await expect(page.getByTestId('agent-context-usage')).toHaveText('83%')
  await expect(page.getByTestId('agent-context-usage')).toHaveClass(/is-warn/)

  // Verify Turn 2 actually replayed Turn 1's tool_call and tool result to the model
  expect(JSON.stringify(lastMessagesSeen)).toContain('call_e2e_ct1')

  // Apply cumulative proposal and verify BOTH Turn 1 & Turn 2 edits landed in editor
  await reviewPane.getByRole('button', { name: '应用变更' }).click()
  await expect(page.locator('.cm-content')).toContainText('第一处已润色。')
  await expect(page.locator('.cm-content')).toContainText('第二处也已顺带润色。')

  // Turn 3: previous inputTokens (3400) >= 80% of 4096 -> triggers auto-compaction divider!
  mode = 'continuity-t3'
  turnStep = 0
  await textarea.fill('继续下一项检查')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('已基于自动压缩摘要继续协助。')).toBeVisible()
  expect(compactionRequestsSeen).toBe(1)
  const compactionDivider = page.getByTestId('agent-compaction-divider')
  await expect(compactionDivider).toBeVisible()
  await compactionDivider.getByRole('button').click()
  await expect(compactionDivider).toContainText('【E2E自动摘要】')
  await expect(page.getByTestId('agent-context-usage')).toHaveText('27%')

  // Reload and verify timeline, superseded card, compaction divider & context usage persist
  await page.reload()
  await page.waitForSelector('.cm-content')
  await page.getByRole('button', { name: '助手' }).click()
  await expect(page.getByText('已被后续修改替代（1 个文件）')).toBeVisible()
  await expect(page.getByTestId('agent-compaction-divider')).toBeVisible()
  await expect(page.getByTestId('agent-context-usage')).toHaveText('27%')
})

test('multi-step reasoning isolates per-block thinking status and collapses process above final reply', async ({
  page,
}) => {
  const bookId = await seedBook()
  await resetAgentState()

  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await page.waitForSelector('.cm-content')

  await page.getByRole('button', { name: '助手' }).click()
  await page.getByRole('button', { name: '配置模型预设' }).click()
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await dialog.getByLabel('预设名称').fill('双思考测试')
  await dialog.getByLabel('Base URL').fill(`${mockUrl}/v1`)
  await dialog.getByLabel('模型名称').fill('mock-reasoner')
  await dialog.getByRole('button', { name: '添加预设' }).click()
  await expect(dialog.getByText('预设已保存')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  mode = 'multi-reasoning'
  turnStep = 0
  releaseSecondReasoning = null
  const reachedSecondReasoning = new Promise<void>((resolve) => {
    secondReasoningFlushed = resolve
  })

  await page.getByLabel('向助手输入指令').fill('检查第一章是否正常')
  await page.getByRole('button', { name: '发送' }).click()
  await reachedSecondReasoning

  // During streaming step 2: process drawer defaults to collapsed single live status row
  const liveDrawer = page.locator('.agent-turn.is-streaming').getByTestId('agent-process-drawer')
  await expect(liveDrawer).toHaveAttribute('data-live', 'true')
  await expect(liveDrawer.getByTestId('agent-process-toggle')).toContainText('正在深度思考… · 已完成 2 步')
  await expect(liveDrawer.getByTestId('agent-process-timeline')).toHaveCount(0)

  // Expand live drawer: ONLY reasoning #2 is active while reasoning #1 is already settled ('done')
  await liveDrawer.getByTestId('agent-process-toggle').click()
  const liveReasoningBlocks = liveDrawer.getByTestId('agent-process-reasoning')
  await expect(liveReasoningBlocks).toHaveCount(2)
  await expect(liveReasoningBlocks.nth(0)).toHaveAttribute('data-status', 'done')
  await expect(liveReasoningBlocks.nth(0)).toContainText('思考过程')
  await expect(liveReasoningBlocks.nth(0)).not.toContainText('正在思考…')
  await expect(liveReasoningBlocks.nth(1)).toHaveAttribute('data-status', 'active')
  await expect(liveReasoningBlocks.nth(1)).toContainText('正在思考…')
  await expect(liveReasoningBlocks.nth(1)).toContainText('第二阶段思考：已确认内容，准备整理最终回复。')

  // Release final answer -> settles to collapsed summary drawer + single flat final reply
  releaseSecondReasoning?.()
  await expect(page.getByTestId('agent-assistant-reply')).toContainText('双阶段推理完成：第一章结构正常。')
  const settledDrawer = page.getByTestId('agent-process-drawer').last()
  await expect(settledDrawer).toHaveAttribute('data-live', 'false')
  await expect(settledDrawer.getByTestId('agent-process-toggle')).toContainText('思考 2 次 · 调用 1 个工具')
  await expect(settledDrawer.getByTestId('agent-process-timeline')).toHaveCount(0)

  // Expand settled drawer: both reasoning blocks are 'done' and independently toggleable
  await settledDrawer.getByTestId('agent-process-toggle').click()
  const settledReasoningBlocks = settledDrawer.getByTestId('agent-process-reasoning')
  await expect(settledReasoningBlocks).toHaveCount(2)
  await expect(settledReasoningBlocks.nth(0)).toHaveAttribute('data-status', 'done')
  await expect(settledReasoningBlocks.nth(1)).toHaveAttribute('data-status', 'done')
  await settledReasoningBlocks.nth(0).getByRole('button').click()
  await expect(settledReasoningBlocks.nth(0)).toContainText('第一阶段思考：读取第一章确认错字位置。')

  // Reload confirms collapsed drawer + final reply persist
  await page.reload()
  await page.waitForSelector('.cm-content')
  await page.getByRole('button', { name: '助手' }).click()
  await expect(page.getByTestId('agent-assistant-reply')).toContainText('双阶段推理完成：第一章结构正常。')
  await expect(page.getByTestId('agent-process-toggle').last()).toContainText('思考 2 次 · 调用 1 个工具')
})

test('real-time streaming review: live tool updates, fingerprint-preserved pre-decisions, smart follow, and soft-stop preservation', async ({
  page,
}) => {
  const bookId = await seedBook()
  await resetAgentState()

  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await page.waitForSelector('.cm-content')

  await page.getByRole('button', { name: '助手' }).click()
  await page.getByRole('button', { name: '配置模型预设' }).click()
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await dialog.getByLabel('预设名称').fill('实时审阅测试')
  await dialog.getByLabel('Base URL').fill(`${mockUrl}/v1`)
  await dialog.getByLabel('模型名称').fill('mock-fast')
  await dialog.getByRole('button', { name: '添加预设' }).click()
  await expect(dialog.getByText('预设已保存')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  // Seed ch001.xhtml with 3 distinct paragraphs
  await page.getByRole('button', { name: 'ch001.xhtml', exact: true }).click()
  const initialChapter = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '<head><title>第一章</title><link rel="stylesheet" type="text/css" href="../styles/stylesheet1.css" /></head>',
    '<body>',
    '<p>首段待校对</p>',
    '<p>保留分隔段</p>',
    '<p>中间保持原样的段落</p>',
    '<p>第三段待停止测试</p>',
    '</body>',
    '</html>',
  ].join('\n')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(initialChapter)
  await expect(page.locator('.cm-content')).toContainText('中间保持原样的段落')

  // Part 1: Controlled 2-stage live streaming turn
  mode = 'live-stream'
  turnStep = 0
  releaseLiveStep2 = null
  releaseLiveStep3 = null
  const reachedStep2 = new Promise<void>((resolve) => {
    liveStep2Entered = resolve
  })
  const reachedStep3 = new Promise<void>((resolve) => {
    liveStep3Entered = resolve
  })

  await page.getByLabel('向助手输入指令').fill('分步实时校对第一章并调整样式')
  await page.getByRole('button', { name: '发送' }).click()
  await reachedStep2

  // Main canvas opens immediately on first write tool while turn is still streaming!
  const reviewPane = page.locator('.review-pane')
  await expect(reviewPane).toBeVisible()
  await expect(reviewPane.getByTestId('review-live-pill')).toContainText('实时更新中')
  await expect(page.getByTestId('agent-live-proposal-card')).toBeVisible()
  await expect(reviewPane.getByRole('button', { name: '生成中…' })).toBeDisabled()

  // Pre-decide mid-stream: reject hunk-0 inside book-page revision view, then switch to 源码 (pauses auto-follow)
  const liveFrame = reviewPane.frameLocator('.review-book-frame')
  await expect(liveFrame.locator('.bs-rev-ins').first()).toContainText('实时第一步已校对')
  await liveFrame.locator('[data-bs-action="reject-hunk"][data-bs-target-hunk="hunk-0"]').click()
  await expect(liveFrame.locator('[data-bs-hunk="hunk-0"]')).toHaveAttribute('data-bs-rev', 'rejected')
  await reviewPane.getByRole('button', { name: '源码' }).click()

  // Release Step 2: inserts a new edit ABOVE the rejected hunk in ch001.xhtml AND edits stylesheet1.css
  releaseLiveStep2?.()
  await reachedStep3

  // Because user manually switched view mode, auto-follow paused (stays on ch001.xhtml) and shows follow-resume pill!
  await expect(reviewPane.locator('.review-file-trigger-name')).toHaveText('ch001.xhtml')
  await expect(reviewPane.getByTestId('review-follow-pill')).toContainText('stylesheet1.css')

  // Fingerprint reconciliation preserved the earlier rejection on the now-shifted hunk-1, while new hunk-0 is pending!
  await expect(reviewPane.locator('.review-src-hunk')).toHaveCount(2)
  await expect(reviewPane.locator('[data-review-source-hunk="hunk-0"]')).toHaveAttribute('data-decision', 'pending')
  await expect(reviewPane.locator('[data-review-source-hunk="hunk-1"]')).toHaveAttribute('data-decision', 'rejected')

  // Click follow-resume pill -> jumps cleanly to latest touched file (stylesheet1.css)
  await reviewPane.getByTestId('review-follow-pill').click()
  await expect(reviewPane.locator('.review-file-trigger-name')).toHaveText('stylesheet1.css')

  // Release Step 3 -> turn settles, unlocks Apply button keeping 2/3 hunks (1 rejected in ch001)
  releaseLiveStep3?.()
  await expect(page.getByText('实时多步校对已完成，请确认最终应用。')).toBeVisible()
  await expect(reviewPane.getByTestId('review-live-pill')).toHaveCount(0)
  await expect(reviewPane.getByRole('button', { name: '应用已选（2/3 处）' })).toBeEnabled()

  await reviewPane.getByRole('button', { name: '应用已选（2/3 处）' }).click()
  await expect(reviewPane).toBeHidden()
  await expect(page.locator('.cm-content')).toContainText('首段实时新增改动')
  await expect(page.locator('.cm-content')).toContainText('中间保持原样的段落')
  await expect(page.locator('.cm-content')).not.toContainText('实时第一步已校对')

  // Save changes so next soft-stop test starts on clean synced version
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.appbar-save.is-saved')).toBeVisible()

  // Part 2: Mid-turn soft stop preserves completed step-1 edit as a persisted pending proposal!
  mode = 'live-soft-stop'
  turnStep = 0
  const reachedStopStep2 = new Promise<void>((resolve) => {
    liveStopStep2Entered = resolve
  })

  await page.getByLabel('向助手输入指令').fill('修改第三段然后测试中途停止')
  await page.getByRole('button', { name: '发送' }).click()
  await reachedStopStep2

  await expect(reviewPane).toBeVisible()
  await expect(reviewPane.getByTestId('review-live-pill')).toBeVisible()
  await expect(reviewPane.frameLocator('.review-book-frame').locator('[data-bs-hunk="hunk-0"]')).toContainText(
    '前已完成的修改',
  )

  // Click soft-stop button right inside the review footer bar
  await reviewPane.getByTestId('review-stop-live-btn').click()

  // Turn settles with preserved pending proposal and unlocks Apply!
  await expect(reviewPane.getByTestId('review-live-pill')).toHaveCount(0)
  await expect(reviewPane.getByRole('button', { name: '应用变更' })).toBeEnabled()

  // Reload page -> verify the soft-stopped partial proposal persisted in Postgres and can be applied
  await page.reload()
  await page.waitForSelector('.cm-content')
  await page.getByRole('button', { name: '助手' }).click()
  await expect(page.getByRole('button', { name: '审阅变更' }).last()).toBeVisible()
  await page.getByRole('button', { name: '审阅变更' }).last().click()
  await expect(reviewPane).toBeVisible()
  await reviewPane.getByRole('button', { name: '应用变更' }).click()
  await expect(reviewPane).toBeHidden()
  await page.getByRole('button', { name: 'ch001.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('停止前已完成的修改')
})

test('structure-aware quote review coalesces wrappers, renders inline quote typo diff, and toggles mini source diff', async ({
  page,
}) => {
  const bookId = await seedBook()
  await resetAgentState()

  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await page.waitForSelector('.cm-content')

  await page.getByRole('button', { name: '助手' }).click()
  await page.getByRole('button', { name: '配置模型预设' }).click()
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await dialog.getByLabel('预设名称').fill('引用审阅测试')
  await dialog.getByLabel('Base URL').fill(`${mockUrl}/v1`)
  await dialog.getByLabel('模型名称').fill('mock-fast')
  await dialog.getByRole('button', { name: '添加预设' }).click()
  await expect(dialog.getByText('预设已保存')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('button', { name: 'ch001.xhtml', exact: true }).click()
  const chapterXhtml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    '<head><title>第一章</title><link rel="stylesheet" type="text/css" href="../styles/stylesheet1.css" /></head>',
    '<body>',
    '<p>待包裹引文一</p>',
    '<p>待包裹引文二</p>',
    '<p>正文分隔段落</p>',
    '<blockquote><p>已有引文错字示例</p></blockquote>',
    '</body>',
    '</html>',
  ].join('\n')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(chapterXhtml)
  await expect(page.locator('.cm-content')).toContainText('已有引文错字示例')

  mode = 'quote-review'
  turnStep = 0
  await page.getByLabel('向助手输入指令').fill('整理引文并修正已有引文中的错字')
  await page.getByRole('button', { name: '发送' }).click()

  const reviewPane = page.locator('.review-pane')
  await expect(reviewPane).toBeVisible()
  await expect(page.getByText('已将两段引文包裹为引用块，并修正已有引用中的错字。')).toBeVisible()

  // Coalesced blockquote wrapper + nested quote typo produce exactly 2 hunks (not 3 unbalanced hunks).
  await expect(reviewPane.locator('.review-nav-counter')).toHaveText(/\/2$/)
  const frame = reviewPane.frameLocator('.review-book-frame')
  await expect(frame.locator('[data-bs-hunk="hunk-0"]')).toContainText('包裹为引用 (p×2 → blockquote)')
  await expect(frame.locator('[data-bs-hunk="hunk-0"]')).toContainText('文字未变 · 仅结构/标签调整')
  await expect(frame.locator('body')).not.toContainText('跨行标签变更')
  await expect(frame.locator('body')).not.toContainText('段落结构变更')

  // Expand inline mini-source diff right inside hunk-0 without leaving the book page.
  await frame.locator('[data-bs-action="toggle-diff"][data-bs-target-hunk="hunk-0"]').click()
  await expect(frame.locator('[data-bs-minidiff="hunk-0"]')).toContainText('<blockquote>')
  await frame.locator('[data-bs-action="toggle-diff"][data-bs-target-hunk="hunk-0"]').click()
  await expect(frame.locator('[data-bs-minidiff="hunk-0"]')).toHaveCount(0)

  // Nested blockquote typo renders in-place red/green char diff inside the real blockquote!
  await expect(frame.locator('[data-bs-hunk="hunk-1"] .bs-rev-del')).toHaveText('错')
  await expect(frame.locator('[data-bs-hunk="hunk-1"] .bs-rev-ins')).toHaveText('正')

  // Rejecting the coalesced wrapper hunk alone produces valid XML (no XML validation error!) and applies the typo fix cleanly.
  await frame.locator('[data-bs-action="reject-hunk"][data-bs-target-hunk="hunk-0"]').click()
  await expect(reviewPane.getByRole('button', { name: '应用已选（1/2 处）' })).toBeEnabled()
  await reviewPane.getByRole('button', { name: '应用已选（1/2 处）' }).click()
  await expect(reviewPane).toBeHidden()
  await expect(page.locator('.cm-content')).toContainText('已有引文正字示例')
  await expect(page.locator('.cm-content')).not.toContainText('<blockquote>\n<p>待包裹引文一</p>')
})
