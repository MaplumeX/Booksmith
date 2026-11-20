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
  let store: ReturnType<typeof createDb>

  beforeAll(async () => {
    mockServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const bodyText = await readBody(req)
      const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}

      if (url.pathname === '/v1/chat/completions') {
        if (body.stream !== true) {
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
  })
})
