import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openWorkbench(page: Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
}

test('inserts anchor id, special char, hr, image, and inline/block tags from CodeToolbar', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.code-toolbar')).toBeVisible()

  // Focus a paragraph line inside CodeMirror.
  const paraLine = page.locator('.cm-line', { hasText: '<p' }).first()
  await paraLine.click()

  // Insert anchor ID on current line opening tag.
  await page.getByRole('button', { name: '插入锚点 ID', exact: true }).click()
  await page.getByRole('textbox', { name: '锚点 ID' }).fill('e2e_anchor')
  await page.getByRole('button', { name: '插入 ID', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('id="e2e_anchor"')

  // Insert special character via grouped popover.
  await page.getByRole('button', { name: '插入特殊字符', exact: true }).click()
  await page.getByRole('button', { name: '插入 左直角引号', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('「')

  // Insert <hr /> and book image.
  await page.getByRole('button', { name: '插入分隔线', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('<hr />')

  await page.getByRole('button', { name: '插入书内图片', exact: true }).click()
  await page.locator('.wysiwyg-image-option').first().click()
  await expect(page.locator('.cm-content')).toContainText('<img src="')

  // Wrap inline <strong> at cursor.
  await page.getByRole('button', { name: '加粗标签', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('<strong></strong>')
})

test('formats XHTML and CSS in a single undoable CodeMirror transaction while protecting MathML', async ({ page }) => {
  await openWorkbench(page)

  // Format a chapter containing MathML (ch010.xhtml) and verify MathML stays rendered + single-step undo restores clean baseline.
  await page.getByRole('button', { name: 'ch010.xhtml', exact: true }).click()
  const previewFrame = page.frameLocator('iframe.preview-frame')
  await expect(previewFrame.locator('math').first()).toBeVisible()
  await page.getByRole('button', { name: '美化格式化代码', exact: true }).click()
  await expect(page.locator('.structure-toast')).toContainText(/已格式化|已是规范格式/)
  await expect(previewFrame.locator('math').first()).toBeVisible()

  // Undo in one step returns to clean baseline.
  if (await page.locator('.appbar-flag').isVisible()) {
    await page.locator('.cm-content').click()
    await page.keyboard.press(`${MOD}+z`)
    await expect(page.locator('.appbar-flag')).toHaveCount(0)
  }

  // Open a CSS file -> toolbar adapts to CSS mode (no XHTML split button, format still works).
  await page.getByRole('button', { name: 'stylesheet1.css', exact: true }).click()
  await expect(page.getByRole('button', { name: '在光标处拆分章节' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '美化格式化代码', exact: true })).toBeVisible()

  await page.locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+a`)
  await page.keyboard.type('body{margin:0;padding:4px}')
  await page.getByRole('button', { name: '美化格式化代码', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('margin: 0;')

  // Single Cmd/Ctrl+Z reverts the format step.
  await page.locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.locator('.cm-content')).toContainText('body{margin:0;padding:4px}')
})

test('opens CodePane context menu, Cmd+K CommandPalette across modes, and toggles CodeToolbar in Settings', async ({
  page,
}) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()

  // CodePane right-click context menu.
  await page.locator('.cm-content').click({ button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /在光标处拆分章节/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /美化格式化代码/ })).toBeVisible()
  await page.keyboard.press('Escape')

  // Cmd/Ctrl+K opens CommandPalette, filters commands, and runs Link Stylesheets dialog.
  await page.keyboard.press(`${MOD}+k`)
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await expect(palette).toBeVisible()
  await palette.getByLabel('搜索命令').fill('样式表')
  await expect(palette.getByRole('option', { name: /为当前章关联样式表/ })).toBeVisible()
  await palette.getByRole('option', { name: /为当前章关联样式表/ }).click()
  await expect(page.getByRole('dialog', { name: '关联样式表' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Cmd/Ctrl+K also works when focus is inside the WYSIWYG iframe.
  await page.getByRole('button', { name: '可视化', exact: true }).click()
  const frame = page.frameLocator('iframe.wysiwyg-frame')
  await expect(frame.locator('body p').first()).toBeVisible()
  await frame.locator('body p').first().click()
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Switch back to code mode and hide/show CodeToolbar via Settings.
  await page.getByRole('button', { name: '代码', exact: true }).click()
  await expect(page.locator('.code-toolbar')).toBeVisible()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settingsDialog = page.getByRole('dialog', { name: '应用设置' })
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole('switch', { name: '显示代码工具条' }).click()
  await settingsDialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('.code-toolbar')).toHaveCount(0)

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await settingsDialog.getByRole('switch', { name: '显示代码工具条' }).click()
  await settingsDialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.locator('.code-toolbar')).toBeVisible()
})
