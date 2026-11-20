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

async function clearAgentProfiles(): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL: API })
  await ctx.post('/api/auth/login', { data: { email: E2E_EMAIL, password: E2E_PASSWORD } })
  const res = await ctx.get('/api/agent/profiles')
  if (res.ok()) {
    const body = (await res.json()) as { profiles: Array<{ id: string }> }
    for (const p of body.profiles) await ctx.delete(`/api/agent/profiles/${p.id}`)
  }
  await ctx.dispose()
}

let mockServer: ReturnType<typeof createServer>
let mockUrl = ''
let mode: 'proofread' | 'chapter' = 'proofread'
let turnStep = 0

test.beforeAll(async () => {
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

      turnStep += 1
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
                  content: '已定位并修正 **未保存草稿** 中的错字（`ch001.xhtml`）。',
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
          choices: [{ index: 0, delta: { role: 'assistant', content: '已生成「后记」章节并同步加入目录。' }, finish_reason: 'stop' }],
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
  await clearAgentProfiles()
  await new Promise<void>((resolve) => mockServer.close(() => resolve()))
})

test('multi-profile setup, streaming proofreading diff apply/undo, structural create, and history persistence', async ({
  page,
}) => {
  const bookId = await seedBook()
  await clearAgentProfiles()

  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await page.waitForSelector('.cm-content')

  // Open dedicated Agent sidebar via topbar toggle button (no 6th tab)
  await expect(page.getByRole('tab', { name: '助手' })).toHaveCount(0)
  await page.getByRole('button', { name: '助手' }).click()
  await expect(page.getByText('配置模型以启用助手')).toBeVisible()

  // Configure first preset + test connection
  await page.getByRole('button', { name: '配置模型预设' }).click()
  const dialog = page.getByRole('dialog', { name: '模型设置' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radio', { name: /OpenAI 兼容/ })).toHaveAttribute('aria-checked', 'true')

  await dialog.getByLabel('预设名称').fill('快速校对')
  await dialog.getByLabel('Base URL').fill(`${mockUrl}/v1`)
  await dialog.getByLabel('模型名称').fill('mock-fast')
  await dialog.getByLabel('API Key（本地模型可留空）').fill('sk-e2e-secret-9999')

  await dialog.getByRole('button', { name: '测试连接' }).click()
  await expect(dialog.getByText(/连接成功/)).toBeVisible()

  await dialog.getByRole('button', { name: '添加预设' }).click()
  await expect(dialog.getByText('预设已保存')).toBeVisible()

  // Add second preset for switching in chat composer
  await dialog.getByRole('button', { name: '新增' }).click()
  await dialog.getByLabel('预设名称').fill('结构重构')
  await dialog.getByLabel('Base URL').fill(`${mockUrl}/v1`)
  await dialog.getByLabel('模型名称').fill('mock-pro')
  await dialog.getByRole('button', { name: '添加预设' }).click()
  await expect(dialog.getByText('预设已保存')).toBeVisible()

  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toBeHidden()

  // Open ch001.xhtml and make an unsaved edit
  await page.getByRole('button', { name: 'ch001.xhtml', exact: true }).click()
  const docWithTypo = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><p>未保存测试错字</p></body></html>',
  ].join('\n')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(docWithTypo)
  await expect(page.locator('.cm-content')).toContainText('未保存测试错字')

  // Verify context chip can be dismissed and re-attached cleanly
  await page.getByRole('button', { name: '移除当前文件上下文' }).click()
  await page.getByRole('button', { name: '重新挂载当前文件上下文' }).click()
  await expect(page.locator('.agent-context-chip')).toContainText('ch001.xhtml')

  // Turn 1: pure text proofreading proposal on unsaved edit (with Markdown rendering check)
  mode = 'proofread'
  turnStep = 0
  await page.getByLabel('向助手输入指令').fill('帮我修正未保存的错字')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.locator('.agent-bubble.is-assistant .agent-md strong')).toContainText('未保存草稿')
  await expect(page.locator('.agent-bubble.is-assistant .agent-md code')).toContainText('ch001.xhtml')
  await expect(page.getByText('纯文本 · 可勾选')).toBeVisible()
  await expect(page.locator('.diff-inline-added')).toContainText('已校对正确文本')

  // Apply proposal -> editor updates immediately, then undo restores original text
  await page.getByRole('button', { name: '应用变更' }).click()
  await expect(page.getByText('已应用变更到工作区')).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('已校对正确文本')

  await page.getByRole('button', { name: '撤销本次应用' }).click()
  await expect(page.locator('.cm-content')).toContainText('未保存测试错字')

  // Turn 2: switch model via Radix menu and run structural create_chapter proposal
  mode = 'chapter'
  turnStep = 0
  await page.getByRole('button', { name: '选择模型预设' }).click()
  await page.getByRole('menuitemradio', { name: /结构重构/ }).click()
  await page.getByLabel('向助手输入指令').fill('新建后记章节并加入目录')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('已生成「后记」章节并同步加入目录。')).toBeVisible()
  await expect(page.getByText('结构变更 · 整批应用')).toBeVisible()

  await page.getByRole('button', { name: '应用全部变更' }).click()
  await expect(page.getByRole('button', { name: 'afterword.xhtml', exact: true })).toBeVisible()

  // Rename thread inside Radix history Popover and verify persistence across reload
  await page.getByRole('button', { name: '切换历史对话' }).click()
  await page.locator('.agent-history-row-actions button').first().click()
  await page.getByLabel('输入新对话标题').fill('第一章校对记录')
  await page.getByRole('button', { name: '保存标题' }).click()
  await expect(page.locator('.agent-thread-trigger-title')).toHaveText('第一章校对记录')
  await page.keyboard.press('Escape')

  // Reload page and confirm thread title, history & applied status persisted in Postgres
  await page.reload()
  await page.waitForSelector('.cm-content')
  await page.getByRole('button', { name: '助手' }).click()
  await expect(page.locator('.agent-thread-trigger-title')).toHaveText('第一章校对记录')
  await expect(page.getByText('已生成「后记」章节并同步加入目录。')).toBeVisible()
  await expect(page.getByText('已应用变更到工作区').first()).toBeVisible()

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
