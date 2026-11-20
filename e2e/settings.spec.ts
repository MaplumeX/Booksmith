import { expect, test } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

test('switches global theme from Library settings and persists across reload', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await expect(dialog).toBeVisible()
  // Library header has a single unified Settings entry (no standalone 模型设置 button).
  await expect(page.getByRole('button', { name: '模型设置' })).toHaveCount(0)
  await expect(dialog.getByRole('tab', { name: '通用' })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('tab', { name: 'AI 助手' }).click()
  await expect(dialog.getByRole('tab', { name: 'AI 助手' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByText('预设列表')).toBeVisible()
  await dialog.getByRole('tab', { name: '通用' }).click()

  await dialog.getByRole('radio', { name: /深色/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dialog).toBeHidden()

  await page.reload()
  await expectLoggedIn(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  // Switch explicitly to light and verify persistence.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByRole('radio', { name: /浅色/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()

  await page.reload()
  await expectLoggedIn(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('syncs both split preview and WYSIWYG mode with global theme and applies editor settings', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.tab.on')).toContainText('ch003.xhtml')

  const previewFrame = page.frameLocator('.preview-frame')
  await expect(previewFrame.locator('body')).toContainText('序言')

  // Open settings from editor topbar and switch to dark theme + larger font size + disable word wrap.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await expect(dialog).toBeVisible()

  await dialog.getByRole('radio', { name: /深色/ }).click()
  await dialog.getByRole('button', { name: '增大代码字号' }).click()
  await dialog.getByRole('button', { name: '增大代码字号' }).click()
  await expect(dialog.getByTestId('code-font-size-value')).toHaveText('15px')

  const wrapSwitch = dialog.getByRole('switch', { name: '代码自动换行' })
  await expect(wrapSwitch).toHaveAttribute('aria-checked', 'true')
  await wrapSwitch.click()
  await expect(wrapSwitch).toHaveAttribute('aria-checked', 'false')

  await dialog.getByRole('button', { name: '完成', exact: true }).click()

  // Verify global theme applies to root, code font size, word wrap, and split preview iframe.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const editorStyles = await page.evaluate(() => {
    const cm = document.querySelector<HTMLElement>('.cm-editor')!
    const cmContent = document.querySelector<HTMLElement>('.cm-content')!
    const preview = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    return {
      fontSize: getComputedStyle(cm).fontSize,
      hasLineWrappingClass: cmContent.classList.contains('cm-lineWrapping'),
      previewBg: getComputedStyle(preview.contentDocument!.body).backgroundColor,
      previewColor: getComputedStyle(preview.contentDocument!.body).color,
    }
  })
  expect(editorStyles.fontSize).toBe('15px')
  expect(editorStyles.hasLineWrappingClass).toBe(false)
  expect(editorStyles.previewBg).toBe('rgb(26, 27, 36)')
  expect(editorStyles.previewColor).toBe('rgb(236, 236, 242)')

  // Switch to WYSIWYG mode: it must follow dark global theme and have no local toggle button.
  await page.getByRole('button', { name: '可视化', exact: true }).click()
  await expect(page.getByRole('button', { name: /切换(暗色|浅色)纸面/ })).toHaveCount(0)
  const wysiwygFrame = page.frameLocator('.wysiwyg-frame')
  await expect(wysiwygFrame.locator('body')).toContainText('序言')
  const wysiwygBg = await wysiwygFrame
    .locator('body')
    .evaluate((body) => getComputedStyle(body).backgroundColor)
  expect(wysiwygBg).toBe('rgb(26, 27, 36)')

  // Reset to defaults and verify both theme and editor settings restore.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByRole('button', { name: '恢复默认' }).click()
  await expect(dialog.getByTestId('code-font-size-value')).toHaveText('13px')
  await expect(dialog.getByRole('switch', { name: '代码自动换行' })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('radio', { name: /跟随系统/ })).toHaveAttribute('aria-checked', 'true')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
})
