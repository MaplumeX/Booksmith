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
  | 'auto-edit'
  | 'retry-fail'
  | 'retry-ok' = 'proofread'
let turnStep = 0
let lastModelSeen = ''
let lastToolCountSeen = 0
let lastSystemPromptSeen = ''

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

  // Expand collapsed reasoning trace block
  await page.getByRole('button', { name: /思考过程/ }).click()
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

  await expect(page.locator('.agent-bubble.is-assistant .agent-md strong')).toContainText('未保存草稿')
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

  // Skip the 2nd hunk directly inside the book-page revision view
  await revFrame.locator('[data-bs-action="toggle-hunk"][data-bs-target-hunk="hunk-1"]').click()
  await expect(revFrame.locator('[data-bs-hunk="hunk-1"]')).toContainText('第二处待定措辞')
  await expect(reviewPane.getByRole('button', { name: '应用已选（1/2 处）' })).toBeVisible()

  // Switch to "终稿" view and verify skipped hunk stays original while kept hunk is updated
  await reviewPane.getByRole('button', { name: '终稿' }).click()
  const finalFrame = reviewPane.frameLocator('.review-book-frame')
  await expect(finalFrame.locator('body')).toContainText('已校对正确文本')
  await expect(finalFrame.locator('body')).toContainText('第二处待定措辞')
  await expect(finalFrame.locator('body')).not.toContainText('第二处改写措辞')

  // Switch to "源码" view and verify line numbers & shared skipped hunk state
  await reviewPane.getByRole('button', { name: '源码' }).click()
  await expect(reviewPane.locator('.review-src-hunk')).toHaveCount(2)
  await expect(reviewPane.locator('.review-src-hunk.is-skipped')).toHaveCount(1)

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
