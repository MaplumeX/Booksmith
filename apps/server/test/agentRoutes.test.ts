import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createEmptyEpub } from '@booksmith/core'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createDb } from '../src/db/client'
import { users } from '../src/db/schema'
import { TEST_URL } from './global-setup'

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

async function registerAndCookie(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'strong-password-123' }),
  })
  expect(res.status).toBe(201)
  const direct = (res.headers.getSetCookie?.()[0] ?? '').split(';')[0]
  if (direct) return direct
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'strong-password-123' }),
  })
  expect(login.status).toBe(200)
  return (login.headers.getSetCookie?.()[0] ?? '').split(';')[0]!
}

describe('agent REST & SSE routes', () => {
  const secretKey = randomBytes(32)
  const emailA = `agent-a-${Date.now()}@booksmith.test`
  const emailB = `agent-b-${Date.now()}@booksmith.test`

  let app: FastifyInstance
  let appUrl = ''
  let noSecretApp: FastifyInstance
  let noSecretUrl = ''
  let mockServer: ReturnType<typeof createServer>
  let mockUrl = ''
  let mockStep = 0
  let slowToolStep = 0
  let slowStep2Aborted = false
  let slowStep2Completed = false
  let slowEmptyAborted = false
  let lastSeenModel: string | null = null
  let lastSeenSystem: string | null = null
  let lastSeenToolCount = 0
  let capturedChatMessages: Array<Array<{ role?: string; content?: string }>> = []
  let continuityStep = 0
  let compactionCallCount = 0
  let store: ReturnType<typeof createDb>

  beforeAll(async () => {
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
        lastSeenModel = typeof body.model === 'string' ? body.model : null
        const msgs = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: string }>) : []
        lastSeenSystem = msgs.find((m) => m.role === 'system')?.content ?? null
        lastSeenToolCount = Array.isArray(body.tools) ? body.tools.length : 0
        if (body.stream === true) {
          capturedChatMessages.push(msgs)
        }

        if (body.stream !== true) {
          const isCompaction = msgs.some(
            (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('上下文压缩器'),
          )
          if (isCompaction) {
            compactionCallCount += 1
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({
                id: `compact-${compactionCallCount}`,
                object: 'chat.completion',
                created: 1,
                model: body.model ?? 'mock',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: '【持久化摘要】前两轮已完成第一章两处正文校对并记录撤销状态。',
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
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

        if (body.model === 'mock-continuity') {
          continuityStep += 1
          if (continuityStep === 1) {
            // Turn 1 step 1: edit first line
            writeOpenAiSse(res, [
              {
                id: 'ct1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-continuity',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      content: '先修改第一句。',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_ct_1',
                          type: 'function',
                          function: {
                            name: 'edit_file',
                            arguments: JSON.stringify({
                              path: 'EPUB/text/ch001.xhtml',
                              oldText: '<p>从这里开始写。</p>',
                              newText: '<p>第一轮修订完成。</p>\n<p>待微调句。</p>',
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
                id: 'ct1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-continuity',
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              },
            ])
            return
          }
          if (continuityStep === 2) {
            // Turn 1 step 2: summary
            writeOpenAiSse(res, [
              {
                id: 'ct2',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-continuity',
                choices: [{ index: 0, delta: { role: 'assistant', content: '已完成第一轮修改。' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 600, completion_tokens: 20, total_tokens: 620 },
              },
            ])
            return
          }
          if (continuityStep === 3) {
            // Turn 2 step 1: edit on top of unapplied Turn 1 pending proposal!
            writeOpenAiSse(res, [
              {
                id: 'ct3',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-continuity',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_ct_2',
                          type: 'function',
                          function: {
                            name: 'edit_file',
                            arguments: JSON.stringify({
                              path: 'EPUB/text/ch001.xhtml',
                              oldText: '<p>待微调句。</p>',
                              newText: '<p>第二轮顺带微调完成。</p>',
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
                id: 'ct3',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-continuity',
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              },
            ])
            return
          }
          if (continuityStep === 4) {
            writeOpenAiSse(res, [
              {
                id: 'ct4',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-continuity',
                choices: [{ index: 0, delta: { role: 'assistant', content: '已在原草稿上叠加微调。' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3400, completion_tokens: 24, total_tokens: 3424 },
              },
            ])
            return
          }
          writeOpenAiSse(res, [
            {
              id: `ct-${continuityStep}`,
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-continuity',
              choices: [{ index: 0, delta: { role: 'assistant', content: '已收到压缩摘要与最新状态。' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1100, completion_tokens: 18, total_tokens: 1118 },
            },
          ])
          return
        }

        if (body.model === 'mock-reasoner') {
          writeOpenAiSse(res, [
            {
              id: 'rs1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-reasoner',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', reasoning_content: '逐步核查全文术语。' },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'rs1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-reasoner',
              choices: [
                {
                  index: 0,
                  delta: { content: '已用推理模型给出建议。' },
                  finish_reason: 'stop',
                },
              ],
            },
          ])
          return
        }

        if (body.model === 'mock-retry-ok') {
          writeOpenAiSse(res, [
            {
              id: 'rt1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock-retry-ok',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: '换模型重试成功。' },
                  finish_reason: 'stop',
                },
              ],
            },
          ])
          return
        }

        if (body.model === 'mock-slow-tools') {
          slowToolStep += 1
          if (slowToolStep === 1) {
            writeOpenAiSse(res, [
              {
                id: 'st1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-slow-tools',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_slow_1',
                          type: 'function',
                          function: {
                            name: 'edit_file',
                            arguments: JSON.stringify({
                              path: 'EPUB/text/ch001.xhtml',
                              oldText: '<p>从这里开始写。</p>',
                              newText: '<p>中途被中断的修改。</p>',
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
                id: 'st1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-slow-tools',
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              },
            ])
            return
          }

          // Step 2 stays open long enough for the client to abort mid-turn, emitting SSE keepalives
          // so Node's mock http.Server observes TCP RST as soon as Booksmith aborts the upstream fetch.
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          res.flushHeaders?.()
          const ping = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) res.write(': upstream-ping\n\n')
          }, 40)
          const timer = setTimeout(() => {
            clearInterval(ping)
            if (res.writableEnded || res.destroyed) return
            slowStep2Completed = true
            res.write(
              `data: ${JSON.stringify({
                id: 'st2',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-slow-tools',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: '如果未中断就会看到这段话。' },
                    finish_reason: 'stop',
                  },
                ],
              })}\n\n`,
            )
            res.write('data: [DONE]\n\n')
            res.end()
          }, 400)
          res.on('close', () => {
            clearInterval(ping)
            clearTimeout(timer)
            if (!res.writableEnded) slowStep2Aborted = true
          })
          return
        }

        if (body.model === 'mock-slow-empty') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          res.flushHeaders?.()
          const ping = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) res.write(': upstream-ping\n\n')
          }, 40)
          const timer = setTimeout(() => {
            clearInterval(ping)
            if (res.writableEnded || res.destroyed) return
            res.write(
              `data: ${JSON.stringify({
                id: 'se1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'mock-slow-empty',
                choices: [{ index: 0, delta: { role: 'assistant', content: '太晚了。' }, finish_reason: 'stop' }],
              })}\n\n`,
            )
            res.write('data: [DONE]\n\n')
            res.end()
          }, 400)
          res.on('close', () => {
            clearInterval(ping)
            clearTimeout(timer)
            if (!res.writableEnded) slowEmptyAborted = true
          })
          return
        }

        mockStep += 1
        if (mockStep === 1) {
          writeOpenAiSse(res, [
            {
              id: 's1',
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
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'edit_file',
                          arguments: JSON.stringify({
                            path: 'EPUB/text/ch001.xhtml',
                            oldText: '草稿里的错别字',
                            newText: '修正后的文字',
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
              id: 's1',
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
            id: 's2',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock',
            choices: [{ index: 0, delta: { role: 'assistant', content: '已修正草稿错别字。' }, finish_reason: 'stop' }],
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

    app = await createApp({
      databaseUrl: TEST_URL,
      agentSseHeartbeatMs: 50,
      config: {
        databaseUrl: TEST_URL,
        allowedEmails: [emailA, emailB],
        sessionTtlDays: 30,
        cookieSecure: false,
        agentSecretKey: secretKey,
      },
    })
    appUrl = await app.listen({ port: 0, host: '127.0.0.1' })

    noSecretApp = await createApp({
      databaseUrl: TEST_URL,
      config: {
        databaseUrl: TEST_URL,
        allowedEmails: [emailA],
        sessionTtlDays: 30,
        cookieSecure: false,
        agentSecretKey: null,
      },
    })
    noSecretUrl = await noSecretApp.listen({ port: 0, host: '127.0.0.1' })
    store = createDb(TEST_URL)
  })

  afterAll(async () => {
    await app.close()
    await noSecretApp.close()
    await new Promise<void>((resolve) => mockServer.close(() => resolve()))
    await store.db.delete(users)
    await store.sql.end()
  })

  it('rejects unauthenticated requests with 401 and returns 503 when AGENT_SECRET_KEY is missing', async () => {
    const unauth = await fetch(`${appUrl}/api/agent/profiles`)
    expect(unauth.status).toBe(401)

    const cookieA = await registerAndCookie(appUrl, emailA)

    // Without AGENT_SECRET_KEY: saving an API key returns 503, but keyless local Ollama succeeds!
    const failWithKey = await fetch(`${noSecretUrl}/api/agent/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        name: 'Cloud Key',
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/v1`,
        model: 'gpt-4o-mini',
        apiKey: 'sk-should-block-503',
      }),
    })
    expect(failWithKey.status).toBe(503)

    const keylessOk = await fetch(`${noSecretUrl}/api/agent/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        name: 'Local Ollama',
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/v1`,
        model: 'qwen2.5:14b',
        apiKey: '',
      }),
    })
    expect(keylessOk.status).toBe(201)
    const keylessBody = (await keylessOk.json()) as { profile: { id: string; hasApiKey: boolean } }
    expect(keylessBody.profile.hasApiKey).toBe(false)

    // Clean up profile created on noSecretApp
    await fetch(`${appUrl}/api/agent/profiles/${keylessBody.profile.id}`, {
      method: 'DELETE',
      headers: { cookie: cookieA },
    })
  })

  it('manages multi-profile CRUD, masks API keys, isolates users, and streams SSE proposals', async () => {
    // Login A and register B
    const loginA = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'strong-password-123' }),
    })
    const cookieA = (loginA.headers.getSetCookie?.()[0] ?? '').split(';')[0]!
    const cookieB = await registerAndCookie(appUrl, emailB)

    // Create profile 1 (auto-default) with encrypted key
    const p1Res = await fetch(`${appUrl}/api/agent/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        name: '主力校对',
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/v1`,
        model: 'mock-model-1',
        apiKey: 'sk-secret-value-4321',
      }),
    })
    expect(p1Res.status).toBe(201)
    const p1Json = (await p1Res.json()) as {
      profile: { id: string; isDefault: boolean; hasApiKey: boolean; apiKeyLast4: string }
    }
    expect(p1Json.profile.isDefault).toBe(true)
    expect(p1Json.profile.hasApiKey).toBe(true)
    expect(p1Json.profile.apiKeyLast4).toBe('4321')
    expect(JSON.stringify(p1Json)).not.toContain('sk-secret-value-4321')

    // Update model name without touching API key -> key stays intact and testable by profileId
    const patchP1 = await fetch(`${appUrl}/api/agent/profiles/${p1Json.profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ model: 'mock-model-2' }),
    })
    expect(patchP1.status).toBe(200)
    const patched = (await patchP1.json()) as { profile: { model: string; hasApiKey: boolean; apiKeyLast4: string } }
    expect(patched.profile.model).toBe('mock-model-2')
    expect(patched.profile.hasApiKey).toBe(true)
    expect(patched.profile.apiKeyLast4).toBe('4321')

    const testConn = await fetch(`${appUrl}/api/agent/profiles/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        profileId: p1Json.profile.id,
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/v1`,
        model: 'mock-model-2',
      }),
    })
    expect(testConn.status).toBe(200)
    expect(((await testConn.json()) as { ok: boolean }).ok).toBe(true)

    // Cross-user isolation on profile
    const bPatchA = await fetch(`${appUrl}/api/agent/profiles/${p1Json.profile.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      body: JSON.stringify({ name: 'hack' }),
    })
    expect(bPatchA.status).toBe(404)

    // Upload a book as user A
    const epub = createEmptyEpub({ title: '路由测试书' })
    const uploadRes = await fetch(`${appUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/epub+zip', cookie: cookieA },
      body: Buffer.from(epub),
    })
    expect(uploadRes.status).toBe(201)
    const { book } = (await uploadRes.json()) as { book: { id: string; currentVersion: number } }

    // Create thread
    const threadRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({}),
    })
    expect(threadRes.status).toBe(201)
    const { thread } = (await threadRes.json()) as { thread: { id: string } }

    // Cross-user isolation on thread
    const bReadThread = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}`, {
      headers: { cookie: cookieB },
    })
    expect(bReadThread.status).toBe(404)

    // Stale baseVersion -> 409 conflict
    const conflictRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ content: '检查一下', baseVersion: book.currentVersion + 1 }),
    })
    expect(conflictRes.status).toBe(409)

    // Valid SSE streaming turn with browser unsaved dirtyTexts overlay
    mockStep = 0
    const dirtyChapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>一</title></head><body><p>草稿里的错别字</p></body></html>`

    const sseRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        content: '帮我改一下未保存草稿里的错别字',
        baseVersion: book.currentVersion,
        dirtyTexts: { 'EPUB/text/ch001.xhtml': dirtyChapter },
        context: { activePath: 'EPUB/text/ch001.xhtml' },
      }),
    })
    expect(sseRes.status).toBe(200)
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream')
    expect(sseRes.headers.get('x-accel-buffering')).toBe('no')

    const rawSse = await sseRes.text()
    const events = rawSse
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>)

    expect(events.some((e) => e.type === 'tool_start')).toBe(true)
    expect(events.some((e) => e.type === 'tool_end')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    expect(events.some((e) => e.type === 'proposal')).toBe(true)
    const doneEvent = events.find((e) => e.type === 'done') as { messageId: string; threadTitle: string }
    expect(doneEvent.messageId).toBeTruthy()
    expect(doneEvent.threadTitle).toContain('帮我改一下')

    // Read persisted thread and messages
    const detailRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}`, {
      headers: { cookie: cookieA },
    })
    expect(detailRes.status).toBe(200)
    const detail = (await detailRes.json()) as {
      messages: Array<{ id: string; role: string; proposalStatus: string | null; proposal: { files: unknown[] } | null }>
    }
    expect(detail.messages).toHaveLength(2)
    expect(detail.messages[1]!.id).toBe(doneEvent.messageId)
    expect(detail.messages[1]!.proposalStatus).toBe('pending')
    expect(detail.messages[1]!.proposal?.files).toHaveLength(1)

    // Mark proposal applied
    const applyRes = await fetch(`${appUrl}/api/books/${book.id}/agent/proposals/${doneEvent.messageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ status: 'applied' }),
    })
    expect(applyRes.status).toBe(200)
    const appliedJson = (await applyRes.json()) as { message: { proposalStatus: string } }
    expect(appliedJson.message.proposalStatus).toBe('applied')

    // Retrying an applied proposal message is blocked with 409
    const blockedRetry = await fetch(
      `${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages/${doneEvent.messageId}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieA },
        body: JSON.stringify({ baseVersion: book.currentVersion }),
      },
    )
    expect(blockedRetry.status).toBe(409)
    expect(((await blockedRetry.json()) as { error: string }).error).toBe('proposal_already_applied')
  })

  it('supports multi-model providers, model fetch proxy, cloud user settings, approval modes, reasoning & last-turn retry', async () => {
    const loginA = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'strong-password-123' }),
    })
    const cookieA = (loginA.headers.getSetCookie?.()[0] ?? '').split(';')[0]!
    const loginB = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailB, password: 'strong-password-123' }),
    })
    const cookieB = (loginB.headers.getSetCookie?.()[0] ?? '').split(';')[0]!

    // Default user settings
    const defaultSettingsRes = await fetch(`${appUrl}/api/agent/settings`, { headers: { cookie: cookieA } })
    expect(defaultSettingsRes.status).toBe(200)
    const defaultSettings = (await defaultSettingsRes.json()) as {
      settings: { defaultApprovalMode: string; maxSteps: number; customInstructions: string }
    }
    expect(defaultSettings.settings).toMatchObject({
      defaultApprovalMode: 'review',
      maxSteps: 15,
      customInstructions: '',
    })

    // Validation rejects negative / non-integer maxSteps, while allowing any positive integer or 0 (unlimited)
    const badSteps = await fetch(`${appUrl}/api/agent/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ maxSteps: -1 }),
    })
    expect(badSteps.status).toBe(400)

    // Save cloud settings for user A (with arbitrary large maxSteps, isolated from user B)
    const saveSettings = await fetch(`${appUrl}/api/agent/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        defaultApprovalMode: 'ask',
        maxSteps: 120,
        customInstructions: '始终保留原文公式与学术引文。',
      }),
    })
    expect(saveSettings.status).toBe(200)
    expect(((await saveSettings.json()) as { settings: { maxSteps: number } }).settings.maxSteps).toBe(120)

    const bSettingsRes = await fetch(`${appUrl}/api/agent/settings`, { headers: { cookie: cookieB } })
    const bSettings = (await bSettingsRes.json()) as { settings: { defaultApprovalMode: string; maxSteps: number } }
    expect(bSettings.settings.defaultApprovalMode).toBe('review')
    expect(bSettings.settings.maxSteps).toBe(15)

    // Create a single provider with multiple models
    const profileRes = await fetch(`${appUrl}/api/agent/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        name: '统一中转站',
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/v1`,
        model: 'mock-fast',
        models: ['mock-fast', 'mock-reasoner', 'mock-retry-ok'],
        apiKey: 'sk-multi-key-8888',
      }),
    })
    expect(profileRes.status).toBe(201)
    const { profile } = (await profileRes.json()) as {
      profile: { id: string; model: string; models: string[] }
    }
    expect(profile.model).toBe('mock-fast')
    expect(profile.models).toEqual(['mock-fast', 'mock-reasoner', 'mock-retry-ok'])

    // Proxy model listing using stored encrypted key via profileId
    const fetchedRes = await fetch(`${appUrl}/api/agent/profiles/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        profileId: profile.id,
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/v1`,
      }),
    })
    expect(fetchedRes.status).toBe(200)
    const fetched = (await fetchedRes.json()) as { ok: boolean; models: string[] }
    expect(fetched.ok).toBe(true)
    expect(fetched.models).toEqual(['mock-fast', 'mock-pro', 'mock-reasoner'])

    // Upload book & create thread -> inherits user defaultApprovalMode ('ask')
    const uploadRes = await fetch(`${appUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/epub+zip', cookie: cookieA },
      body: Buffer.from(createEmptyEpub({ title: '多模型测试书' })),
    })
    const { book } = (await uploadRes.json()) as { book: { id: string; currentVersion: number } }

    const createThreadRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ profileId: profile.id, model: 'mock-reasoner' }),
    })
    expect(createThreadRes.status).toBe(201)
    const { thread } = (await createThreadRes.json()) as {
      thread: { id: string; approvalMode: string; model: string | null }
    }
    expect(thread.approvalMode).toBe('ask')
    expect(thread.model).toBe('mock-reasoner')

    // Send turn using same provider's second model ('mock-reasoner') in ask mode -> reasoning_delta + 7 read-only tools + custom prompt
    const sse1 = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        content: '帮我分析术语',
        baseVersion: book.currentVersion,
        profileId: profile.id,
        model: 'mock-reasoner',
        approvalMode: 'ask',
      }),
    })
    expect(sse1.status).toBe(200)
    const events1 = (await sse1.text())
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>)

    expect(lastSeenModel).toBe('mock-reasoner')
    expect(lastSeenToolCount).toBe(7)
    expect(lastSeenSystem).toContain('始终保留原文公式与学术引文。')
    expect(events1.some((e) => e.type === 'reasoning_delta')).toBe(true)
    const done1 = events1.find((e) => e.type === 'done') as { messageId: string }
    expect(done1.messageId).toBeTruthy()

    // Confirm reasoning persisted on assistant message
    const afterTurn1 = (await (
      await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}`, { headers: { cookie: cookieA } })
    ).json()) as {
      thread: { model: string | null; approvalMode: string }
      messages: Array<{ id: string; role: string; content: string; reasoning: string | null }>
    }
    expect(afterTurn1.messages).toHaveLength(2)
    expect(afterTurn1.messages[1]!.reasoning).toBe('逐步核查全文术语。')

    // Retry last assistant message in-place with a different model on the same provider & auto approval mode
    const retryRes = await fetch(
      `${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages/${done1.messageId}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieA },
        body: JSON.stringify({
          baseVersion: book.currentVersion,
          profileId: profile.id,
          model: 'mock-retry-ok',
          approvalMode: 'auto',
        }),
      },
    )
    expect(retryRes.status).toBe(200)
    const retryEvents = (await retryRes.text())
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>)
    const retryDone = retryEvents.find((e) => e.type === 'done') as { messageId: string; model: string; approvalMode: string }
    expect(retryDone.messageId).toBe(done1.messageId)
    expect(retryDone.model).toBe('mock-retry-ok')
    expect(retryDone.approvalMode).toBe('auto')
    expect(lastSeenModel).toBe('mock-retry-ok')
    expect(lastSeenToolCount).toBe(21)

    // Still only 2 messages (no duplicate user bubble) and thread remembers new model + approvalMode
    const afterRetry = (await (
      await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}`, { headers: { cookie: cookieA } })
    ).json()) as {
      thread: { model: string | null; approvalMode: string }
      messages: Array<{ id: string; role: string; content: string; reasoning: string | null }>
    }
    expect(afterRetry.messages).toHaveLength(2)
    expect(afterRetry.messages[1]!.id).toBe(done1.messageId)
    expect(afterRetry.messages[1]!.content).toBe('换模型重试成功。')
    expect(afterRetry.messages[1]!.reasoning).toBeNull()
    expect(afterRetry.thread.model).toBe('mock-retry-ok')
    expect(afterRetry.thread.approvalMode).toBe('auto')
  })

  it('preserves system prompt across page switches and replays stored per-turn context without mutating persisted message text', async () => {
    const loginA = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'strong-password-123' }),
    })
    const cookieA = (loginA.headers.getSetCookie?.()[0] ?? '').split(';')[0]!

    const uploadRes = await fetch(`${appUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/epub+zip', cookie: cookieA },
      body: Buffer.from(createEmptyEpub({ title: '切页缓存稳定书' })),
    })
    expect(uploadRes.status).toBe(201)
    const { book } = (await uploadRes.json()) as { book: { id: string; currentVersion: number } }

    const createThreadRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ model: 'mock-retry-ok', approvalMode: 'ask' }),
    })
    expect(createThreadRes.status).toBe(201)
    const { thread } = (await createThreadRes.json()) as { thread: { id: string } }

    capturedChatMessages = []

    const turn1Res = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        content: '帮我看第一页的标点',
        baseVersion: book.currentVersion,
        model: 'mock-retry-ok',
        approvalMode: 'ask',
        context: { activePath: 'EPUB/text/ch001.xhtml', selection: '第一页摘录' },
      }),
    })
    expect(turn1Res.status).toBe(200)
    await turn1Res.text()

    const turn2Res = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        content: '帮我看第二页的标题',
        baseVersion: book.currentVersion,
        model: 'mock-retry-ok',
        approvalMode: 'ask',
        context: { activePath: 'EPUB/text/ch002.xhtml', selection: '第二页摘录' },
      }),
    })
    expect(turn2Res.status).toBe(200)
    await turn2Res.text()

    expect(capturedChatMessages).toHaveLength(2)
    const [req1, req2] = capturedChatMessages as [
      Array<{ role?: string; content?: string }>,
      Array<{ role?: string; content?: string }>,
    ]
    const sys1 = req1.find((m) => m.role === 'system')?.content ?? ''
    const sys2 = req2.find((m) => m.role === 'system')?.content ?? ''
    expect(sys1).toBe(sys2)
    expect(sys1).not.toContain('ch001.xhtml')
    expect(sys1).not.toContain('ch002.xhtml')

    // Turn 1's user message is replayed identically on Turn 2
    expect(req2[1]).toEqual(req1[1])
    expect(req1[1]?.content).toContain('EPUB/text/ch001.xhtml')
    expect(req1[1]?.content).toContain('第一页摘录')
    expect(req2[3]?.content).toContain('EPUB/text/ch002.xhtml')
    expect(req2[3]?.content).toContain('第二页摘录')

    // Persisted user messages keep clean raw text and structured context separately for UI rendering
    const detailRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}`, {
      headers: { cookie: cookieA },
    })
    expect(detailRes.status).toBe(200)
    const detail = (await detailRes.json()) as {
      messages: Array<{
        role: string
        content: string
        context: { activePath?: string | null; selection?: string | null } | null
      }>
    }
    expect(detail.messages[0]?.content).toBe('帮我看第一页的标点')
    expect(detail.messages[0]?.context).toEqual({ activePath: 'EPUB/text/ch001.xhtml', selection: '第一页摘录' })
    expect(detail.messages[2]?.content).toBe('帮我看第二页的标题')
    expect(detail.messages[2]?.context).toEqual({ activePath: 'EPUB/text/ch002.xhtml', selection: '第二页摘录' })
  })

  it('aborts running SSE turns and stops upstream multi-step tool execution on client disconnect and explicit abort', async () => {
    const loginA = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'strong-password-123' }),
    })
    const cookieA = (loginA.headers.getSetCookie?.()[0] ?? '').split(';')[0]!
    const loginB = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailB, password: 'strong-password-123' }),
    })
    const cookieB = (loginB.headers.getSetCookie?.()[0] ?? '').split(';')[0]!

    const uploadRes = await fetch(`${appUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/epub+zip', cookie: cookieA },
      body: Buffer.from(createEmptyEpub({ title: '中断测试书' })),
    })
    expect(uploadRes.status).toBe(201)
    const { book } = (await uploadRes.json()) as { book: { id: string; currentVersion: number } }

    const createThreadRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ model: 'mock-slow-tools', approvalMode: 'review' }),
    })
    expect(createThreadRes.status).toBe(201)
    const { thread } = (await createThreadRes.json()) as { thread: { id: string } }

    // Idle abort is idempotent and enforces cross-user isolation
    const idleAbort = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/abort`, {
      method: 'POST',
      headers: { cookie: cookieA },
    })
    expect(idleAbort.status).toBe(200)
    expect(await idleAbort.json()).toEqual({ aborted: false })

    const crossUserAbort = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/abort`, {
      method: 'POST',
      headers: { cookie: cookieB },
    })
    expect(crossUserAbort.status).toBe(404)

    // 1) Client HTTP disconnect (AbortController on fetch) must abort server-side run via reply.raw close
    slowToolStep = 0
    slowStep2Aborted = false
    slowStep2Completed = false

    const clientAc = new AbortController()
    const disconnectRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        content: '执行多步修改并测试断连中断',
        baseVersion: book.currentVersion,
        model: 'mock-slow-tools',
        approvalMode: 'review',
      }),
      signal: clientAc.signal,
    })
    expect(disconnectRes.status).toBe(200)

    const reader = disconnectRes.body!.getReader()
    const decoder = new TextDecoder()
    let seenToolEnd = false
    let buf = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        if (!seenToolEnd && buf.includes('"type":"tool_end"')) {
          seenToolEnd = true
          // Abort while the next read is pending (matching browser consumeAgentSse) once step 2 is in-flight.
          setTimeout(() => clientAc.abort(), 40)
        }
      }
    } catch (error) {
      expect((error as Error).name).toBe('AbortError')
    }
    expect(seenToolEnd).toBe(true)

    // Wait past step 2's 400ms timer to prove server really aborted instead of completing in background.
    await new Promise((r) => setTimeout(r, 500))
    expect(slowStep2Aborted).toBe(true)
    expect(slowStep2Completed).toBe(false)

    const afterDisconnect = (await (
      await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}`, { headers: { cookie: cookieA } })
    ).json()) as {
      messages: Array<{
        role: string
        content: string
        toolCalls: Array<{ name: string }>
        proposal: unknown
      }>
    }
    expect(afterDisconnect.messages).toHaveLength(2)
    expect(afterDisconnect.messages[1]?.content).toBe('已停止生成。')
    expect(afterDisconnect.messages[1]?.toolCalls).toHaveLength(1)
    expect(afterDisconnect.messages[1]?.proposal).toBeNull()

    // 2) Explicit POST .../abort must halt an active turn even if the SSE socket stays open (e.g. behind a proxy)
    slowToolStep = 0
    slowStep2Aborted = false
    slowStep2Completed = false

    const explicitRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        content: '执行多步修改并测试显式中断接口',
        baseVersion: book.currentVersion,
        model: 'mock-slow-tools',
        approvalMode: 'review',
      }),
    })
    expect(explicitRes.status).toBe(200)

    const explicitReader = explicitRes.body!.getReader()
    let explicitRaw = ''
    let triggeredAbort = false
    while (true) {
      const { value, done } = await explicitReader.read()
      if (done) break
      explicitRaw += decoder.decode(value, { stream: true })
      if (!triggeredAbort && explicitRaw.includes('"type":"tool_end"')) {
        triggeredAbort = true
        await new Promise((r) => setTimeout(r, 40))
        const abortRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/abort`, {
          method: 'POST',
          headers: { cookie: cookieA },
        })
        expect(abortRes.status).toBe(200)
        expect(await abortRes.json()).toEqual({ aborted: true })
      }
    }
    expect(triggeredAbort).toBe(true)

    const explicitEvents = explicitRaw
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>)
    const explicitDone = explicitEvents.find((e) => e.type === 'done') as { stopped?: boolean; messageId?: string }
    expect(explicitDone?.stopped).toBe(true)
    expect(explicitDone?.messageId).toBeTruthy()
    expect(explicitEvents.some((e) => e.type === 'proposal')).toBe(false)

    await new Promise((r) => setTimeout(r, 500))
    expect(slowStep2Aborted).toBe(true)
    expect(slowStep2Completed).toBe(false)

    // 3) Aborting before any output arrives must not insert a ghost empty assistant message
    slowEmptyAborted = false
    const emptyAc = new AbortController()
    const emptyRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        content: '在无任何输出前立刻停止',
        baseVersion: book.currentVersion,
        model: 'mock-slow-empty',
        approvalMode: 'ask',
      }),
      signal: emptyAc.signal,
    })
    expect(emptyRes.status).toBe(200)
    const emptyReader = emptyRes.body!.getReader()
    const readPending = emptyReader.read().catch(() => null)
    await new Promise((r) => setTimeout(r, 50))
    emptyAc.abort()
    await readPending
    await new Promise((r) => setTimeout(r, 500))
    expect(slowEmptyAborted).toBe(true)

    const afterEmptyAbort = (await (
      await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}`, { headers: { cookie: cookieA } })
    ).json()) as {
      messages: Array<{ role: string; content: string }>
    }
    // Prior 4 messages (2 turns) + only the 1 new user message (no empty assistant bubble)
    expect(afterEmptyAbort.messages).toHaveLength(5)
    expect(afterEmptyAbort.messages.at(-1)?.role).toBe('user')
  })

  it('persists full tool traces, seeds cumulative pending proposals, records proposal resolutions, and auto-compacts at 80%', async () => {
    const loginA = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'strong-password-123' }),
    })
    const cookieA = (loginA.headers.getSetCookie?.()[0] ?? '').split(';')[0]!

    const epub = createEmptyEpub({ title: '会话连续性测试书' })
    const uploadRes = await fetch(`${appUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/epub+zip', cookie: cookieA },
      body: Buffer.from(epub),
    })
    expect(uploadRes.status).toBe(201)
    const { book } = (await uploadRes.json()) as { book: { id: string; currentVersion: number } }

    // Create a profile with an explicit small contextWindow (4096) so 80% (~3276) triggers predictably on Turn 3
    const profileRes = await fetch(`${appUrl}/api/agent/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        name: '连续会话测试预设',
        provider: 'openai-compatible',
        baseUrl: `${mockUrl}/v1`,
        model: 'mock-continuity',
        contextWindow: 4096,
        modelContextWindows: { 'mock-continuity': 8192 },
      }),
    })
    expect(profileRes.status).toBe(201)
    const { profile } = (await profileRes.json()) as {
      profile: { id: string; contextWindow: number | null; modelContextWindows: Record<string, number> }
    }
    expect(profile.contextWindow).toBe(4096)
    expect(profile.modelContextWindows).toEqual({ 'mock-continuity': 8192 })

    const threadRes = await fetch(`${appUrl}/api/books/${book.id}/agent/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ profileId: profile.id, model: 'mock-continuity', approvalMode: 'review' }),
    })
    expect(threadRes.status).toBe(201)
    const { thread } = (await threadRes.json()) as { thread: { id: string } }

    const parseSse = (raw: string) =>
      raw
        .split('\n\n')
        .filter((b) => b.startsWith('data: '))
        .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>)

    continuityStep = 0
    compactionCallCount = 0
    capturedChatMessages = []

    // Turn 1: produces pending proposal + interleaved timeline
    const t1Res = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ content: '帮我修改第一章第一句', baseVersion: book.currentVersion }),
    })
    expect(t1Res.status).toBe(200)
    const t1Events = parseSse(await t1Res.text())
    const t1Done = t1Events.find((e) => e.type === 'done') as { messageId: string; usage?: { inputTokens: number; contextWindow: number } }
    expect(t1Done.messageId).toBeTruthy()
    expect(t1Done.usage).toEqual({ inputTokens: 600, contextWindow: 4096 })

    // Turn 2: without applying Turn 1 proposal, ask to tweak the second sentence -> seeds Turn 1 pending proposal,
    // emits cumulative proposal covering BOTH edits, and marks Turn 1 proposal `superseded`!
    const t2Res = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ content: '顺便把第二句也微调一下', baseVersion: book.currentVersion }),
    })
    expect(t2Res.status).toBe(200)
    const t2Events = parseSse(await t2Res.text())
    const t2Proposal = t2Events.find((e) => e.type === 'proposal')?.proposal as {
      files: Array<{ beforeText?: string; afterText?: string }>
    }
    const t2Done = t2Events.find((e) => e.type === 'done') as {
      messageId: string
      supersededMessageId: string | null
      usage?: { inputTokens: number; contextWindow: number }
    }
    expect(t2Proposal.files[0]?.beforeText).toContain('<p>从这里开始写。</p>')
    expect(t2Proposal.files[0]?.afterText).toContain('第一轮修订完成。')
    expect(t2Proposal.files[0]?.afterText).toContain('第二轮顺带微调完成。')
    expect(t2Done.supersededMessageId).toBe(t1Done.messageId)
    expect(t2Done.usage?.inputTokens).toBe(3400)

    // Verify Turn 2 upstream request actually replayed Turn 1's tool_calls & role:'tool' result!
    const t2FirstReq = capturedChatMessages[2]!
    expect(JSON.stringify(t2FirstReq)).toContain('call_ct_1')
    expect(t2FirstReq.some((m) => m.role === 'tool')).toBe(true)

    // Record partial-apply resolution then revert on Turn 2 proposal
    const applyRes = await fetch(`${appUrl}/api/books/${book.id}/agent/proposals/${t2Done.messageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({
        status: 'applied',
        resolution: { keptHunks: 1, totalHunks: 2, skippedPaths: ['EPUB/text/ch001.xhtml'] },
      }),
    })
    expect(applyRes.status).toBe(200)
    const applyJson = (await applyRes.json()) as {
      message: { proposalStatus: string; proposalResolution: { keptHunks: number; totalHunks: number } }
    }
    expect(applyJson.message.proposalStatus).toBe('applied')
    expect(applyJson.message.proposalResolution.keptHunks).toBe(1)

    const revertRes = await fetch(`${appUrl}/api/books/${book.id}/agent/proposals/${t2Done.messageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ status: 'reverted' }),
    })
    expect(revertRes.status).toBe(200)
    expect(((await revertRes.json()) as { message: { proposalStatus: string } }).message.proposalStatus).toBe('reverted')

    // Turn 3: previousInputTokens=3400 >= 80% of 4096 (3276) -> triggers auto-compaction & persists summary on thread!
    const t3Res = await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ content: '我刚才撤销了，继续下一步吧', baseVersion: book.currentVersion }),
    })
    expect(t3Res.status).toBe(200)
    const t3Events = parseSse(await t3Res.text())
    expect(compactionCallCount).toBe(1)
    expect(t3Events.some((e) => e.type === 'compacted')).toBe(true)

    const threadAfter = (await (
      await fetch(`${appUrl}/api/books/${book.id}/agent/threads/${thread.id}`, { headers: { cookie: cookieA } })
    ).json()) as {
      thread: {
        compactionSummary: string | null
        compactedUpToMessageId: string | null
        lastInputTokens: number | null
        lastContextWindow: number | null
      }
      messages: Array<{
        id: string
        role: string
        timeline: Array<{ type: string }>
        proposalStatus: string | null
        compactionNotice: { summary: string } | null
      }>
    }

    expect(threadAfter.thread.compactionSummary).toContain('【持久化摘要】')
    expect(threadAfter.thread.compactedUpToMessageId).toBeTruthy()
    expect(threadAfter.thread.lastInputTokens).toBe(1100)
    expect(threadAfter.thread.lastContextWindow).toBe(4096)

    const msg1 = threadAfter.messages.find((m) => m.id === t1Done.messageId)!
    expect(msg1.proposalStatus).toBe('superseded')
    expect(msg1.timeline.map((item) => item.type)).toEqual(['text', 'tool', 'text'])

    const latestAssistant = threadAfter.messages.at(-1)!
    expect(latestAssistant.compactionNotice?.summary).toContain('【持久化摘要】')
  })
})
