import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openChapter(page: Page, file: string) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: file, exact: true }).click()
  await expect(page.locator('.tab.on')).toContainText(file)
}

test('switches to WYSIWYG mode with centered paper canvas and book styles', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  await page.getByRole('button', { name: '可视化', exact: true }).click()

  await expect(page.locator('.wysiwyg-pane')).toBeVisible()
  await expect(page.locator('.code-pane')).toBeHidden()

  const frame = page.frameLocator('.wysiwyg-frame')
  await expect(frame.locator('body')).toContainText('序言')
  const metrics = await frame.locator('body').evaluate((body) => {
    const style = getComputedStyle(body)
    return {
      maxWidth: style.maxWidth,
      textAlign: style.textAlign,
      contentEditable: body.getAttribute('contenteditable'),
    }
  })
  expect(metrics.maxWidth).toBe('760px')
  expect(metrics.textAlign).toBe('justify')
  expect(metrics.contentEditable).toBe('true')
})

test('edits text, splits paragraph, saves, and persists across reload', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  await page.getByRole('button', { name: '可视化', exact: true }).click()

  const frame = page.frameLocator('.wysiwyg-frame')
  const firstPara = frame.locator('p').first()
  await expect(firstPara).toBeVisible()
  await firstPara.click()
  await page.keyboard.type('【校对标记】')
  await page.keyboard.press('Enter')
  await page.keyboard.type('第二段新起内容')

  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('【校对标记】')
  await expect(page.locator('.cm-content')).toContainText('第二段新起内容')
})

test('preserves MathML protection islands and non-blob image srcs when syncing back to code', async ({ page }) => {
  await openChapter(page, 'ch010.xhtml')
  await page.getByRole('button', { name: '可视化', exact: true }).click()

  const frame = page.frameLocator('.wysiwyg-frame')
  const math = frame.locator('math').first()
  await expect(math).toHaveAttribute('contenteditable', 'false')

  await math.click()
  await expect(page.locator('.wysiwyg-context-bar')).toContainText('只读保护节点 <math>')

  const heading = frame.locator('h1').first()
  await heading.click()
  await page.keyboard.type('·修订')

  await page.getByRole('button', { name: '代码', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('·修订')

  // ch010.xhtml is 174KB so CodeMirror virtualizes offscreen lines; verify full synced text via book search.
  await page.getByRole('tab', { name: '查找' }).click()
  const searchInput = page.getByLabel('全书查找')
  await searchInput.fill('<annotation encoding="application/x-tex">')
  await expect(page.locator('.search-group').filter({ hasText: 'ch010.xhtml' })).toBeVisible({ timeout: 15_000 })

  for (const forbidden of ['blob:', 'data-booksmith-', 'contenteditable']) {
    await searchInput.fill(forbidden)
    await expect(page.getByText(/没有匹配/)).toBeVisible({ timeout: 15_000 })
  }

  // Check image src fidelity on cover.xhtml
  await page.getByRole('button', { name: 'cover.xhtml', exact: true }).click()
  await page.getByRole('button', { name: '可视化', exact: true }).click()
  const coverFrame = page.frameLocator('.wysiwyg-frame')
  const img = coverFrame.locator('img').first()
  await expect(img).toBeVisible()
  await img.click()
  await expect(page.locator('.wysiwyg-context-bar input')).toBeVisible()
  await page.locator('.wysiwyg-context-bar input').fill('新封面图注')
  await page.getByRole('button', { name: '更新说明' }).click()

  await page.getByRole('button', { name: '代码', exact: true }).click()
  const coverCode = await page.locator('.cm-content').textContent()
  expect(coverCode).toContain('新封面图注')
  expect(coverCode).not.toContain('blob:')
})

test('supports single-step CodeMirror undo when switching back from WYSIWYG', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  await page.getByRole('button', { name: '可视化', exact: true }).click()

  const frame = page.frameLocator('.wysiwyg-frame')
  await frame.locator('p').first().click()
  await page.keyboard.type('整段待撤回文案')

  await page.getByRole('button', { name: '代码', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('整段待撤回文案')

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.cm-content')).not.toContainText('整段待撤回文案')
})

test('blocks malformed XML from entering WYSIWYG mode and guides back to code', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  await page.locator('.cm-line').first().click()
  await page.keyboard.type('<broken>')

  await page.getByRole('button', { name: '可视化', exact: true }).click()
  await expect(page.locator('.wysiwyg-error-banner')).toBeVisible()
  await expect(page.locator('.wysiwyg-frame')).toHaveCount(0)

  await page.getByRole('button', { name: '切回代码修复' }).click()
  await expect(page.locator('.code-pane')).toBeVisible()
})

test('does not mark an untouched chapter dirty when closing or switching back to code', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  await page.getByRole('button', { name: '可视化', exact: true }).click()

  const frame = page.frameLocator('.wysiwyg-frame')
  await expect(frame.locator('body')).toContainText('序言')
  await frame.locator('p').first().click()

  await page.getByRole('button', { name: '关闭 ch003.xhtml' }).click()
  await expect(page.locator('.statusbar')).toContainText('未修改')
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0)
})

test('preserves WYSIWYG iframe, undo stack, and paper theme without reloading on save', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  await page.getByRole('button', { name: '可视化', exact: true }).click()

  const frame = page.frameLocator('.wysiwyg-frame')
  const firstPara = frame.locator('p').first()
  await expect(firstPara).toBeVisible()

  await page.evaluate(() => {
    const wysiwyg = document.querySelector<HTMLIFrameElement>('.wysiwyg-frame')!
    const preview = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    ;(wysiwyg.contentWindow as unknown as Record<string, unknown>).__wysiwygSessionId = 'stable-wysiwyg'
    ;(preview.contentWindow as unknown as Record<string, unknown>).__previewSessionId = 'stable-preview'
  })

  await firstPara.click()
  await page.keyboard.type('【保存不闪烁】')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')
  await expect(page.frameLocator('.preview-frame').locator('body')).toContainText('【保存不闪烁】')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  // Toggling dark paper theme should also update in place without reloading the iframe.
  await page.getByRole('button', { name: '切换暗色纸面' }).click()

  const afterSaveAndTheme = await page.evaluate(() => {
    const wysiwyg = document.querySelector<HTMLIFrameElement>('.wysiwyg-frame')!
    const preview = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    return {
      wysiwygIntact: (wysiwyg.contentWindow as unknown as Record<string, unknown>).__wysiwygSessionId === 'stable-wysiwyg',
      previewIntact: (preview.contentWindow as unknown as Record<string, unknown>).__previewSessionId === 'stable-preview',
      darkBg: getComputedStyle(wysiwyg.contentDocument!.body).backgroundColor,
    }
  })
  expect(afterSaveAndTheme.wysiwygIntact).toBe(true)
  expect(afterSaveAndTheme.previewIntact).toBe(true)
  expect(afterSaveAndTheme.darkBg).toBe('rgb(27, 34, 44)')

  // Undo stack must still work after saving and toggling paper theme.
  const undoBtn = page.getByRole('button', { name: '撤销', exact: true })
  await expect(undoBtn).toBeEnabled()
  await undoBtn.click()
  await expect(frame.locator('body')).not.toContainText('【保存不闪烁】')
})
