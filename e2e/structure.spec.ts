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

async function openMenu(page: Page, file: string) {
  await page.getByRole('button', { name: file, exact: true }).click({ button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()
}

async function chapterOrder(page: Page): Promise<string[]> {
  return page.locator('.tree-group').first().locator('.tree-name').allTextContents()
}

test('splits a chapter at cursor in code mode, supports toast undo, and persists after save', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')

  // Move cursor onto a middle paragraph line inside <body>.
  const targetLine = page.locator('.cm-line', { hasText: '<p' }).nth(2)
  await targetLine.click()
  await page.keyboard.press(`${MOD}+Enter`)

  await expect(page.locator('.tab.on')).toContainText('ch003_0001.xhtml')
  const orderAfterSplit = await chapterOrder(page)
  expect(orderAfterSplit.indexOf('ch003_0001.xhtml')).toBe(orderAfterSplit.indexOf('ch003.xhtml') + 1)
  await expect(page.locator('.structure-toast')).toContainText('ch003_0001.xhtml')

  // Undo restores original single chapter cleanly.
  await page.locator('.structure-toast-undo').click()
  await expect(page.getByRole('button', { name: 'ch003_0001.xhtml', exact: true })).toHaveCount(0)
  await expect(page.locator('.appbar-flag')).toHaveCount(0)

  // Split again and persist.
  await page.locator('.cm-line', { hasText: '<p' }).nth(2).click()
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(page.locator('.tab.on')).toContainText('ch003_0001.xhtml')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ch003_0001.xhtml', exact: true })).toBeVisible()
})

test('supports WYSIWYG split marker insertion, batch split at markers, and direct WYSIWYG split at cursor', async ({
  page,
}) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await page.getByRole('button', { name: '可视化', exact: true }).click()

  const frame = page.frameLocator('iframe.wysiwyg-frame')
  const secondParagraph = frame.locator('body p').nth(1)
  await expect(secondParagraph).toBeVisible()
  await secondParagraph.click()

  // Insert a split marker in WYSIWYG and verify marker badge + lint warning.
  await page.getByRole('button', { name: '插入拆分标记', exact: true }).click()
  await expect(frame.locator('hr.sigil_split_marker')).toHaveCount(1)
  await expect(page.locator('.tree-marker-badge')).toContainText('✂1')

  await page.getByRole('button', { name: '检查' }).click()
  await expect(page.locator('.check-popover')).toContainText('sigil_split_marker')
  await page.keyboard.press('Escape')

  // Execute batch split at markers via file tree context menu.
  await openMenu(page, 'ch003.xhtml')
  await page.getByRole('menuitem', { name: /按标记拆分/ }).click()
  await expect(page.getByRole('button', { name: 'ch003_0001.xhtml', exact: true })).toBeVisible()
  await expect(page.locator('.tree-marker-badge')).toHaveCount(0)

  // Now split directly at cursor inside WYSIWYG on the new chapter.
  const newFrame = page.frameLocator('iframe.wysiwyg-frame')
  const splitPara = newFrame.locator('body p').nth(1)
  await expect(splitPara).toBeVisible()
  await splitPara.click()
  await page.getByRole('button', { name: '在光标处拆分章节', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ch003_0001_0001.xhtml', exact: true })).toBeVisible()
})

test('duplicates chapters, merges with previous, and merges multi-selected chapters with undo', async ({ page }) => {
  await openWorkbench(page)

  // Duplicate ch003.xhtml -> ch003_copy.xhtml right after it.
  await openMenu(page, 'ch003.xhtml')
  await page.getByRole('menuitem', { name: '复制章节' }).click()
  await expect(page.getByRole('button', { name: 'ch003_copy.xhtml', exact: true })).toBeVisible()

  // Merge ch003_copy.xhtml back into ch003.xhtml.
  await openMenu(page, 'ch003_copy.xhtml')
  await page.getByRole('menuitem', { name: '与上一章合并' }).click()
  await expect(page.getByRole('button', { name: 'ch003_copy.xhtml', exact: true })).toHaveCount(0)
  await expect(page.locator('.structure-toast')).toContainText('已合并 2 章至 ch003.xhtml')

  // Multi-select merge ch002 + ch003, then undo via toast.
  await page.getByRole('button', { name: '多选章节', exact: true }).click()
  await page.getByLabel('选择 ch002.xhtml').check()
  await page.getByLabel('选择 ch003.xhtml').check()
  await page.getByRole('button', { name: '合并选中章节', exact: true }).click()

  await expect(page.getByRole('button', { name: 'ch003.xhtml', exact: true })).toHaveCount(0)
  await expect(page.locator('.structure-toast')).toContainText('已合并 2 章至 ch002.xhtml')

  await page.locator('.structure-toast-undo').click()
  await expect(page.getByRole('button', { name: 'ch003.xhtml', exact: true })).toBeVisible()
})

test('creates a stylesheet, links/unlinks it on a chapter, and cleans up unused resources', async ({ page }) => {
  await openWorkbench(page)

  // Create a blank stylesheet from the STYLES header.
  await page.getByRole('button', { name: '新建样式表', exact: true }).click()
  await expect(page.getByRole('button', { name: 'style001.css', exact: true })).toBeVisible()

  // Link style001.css to ch003.xhtml via LinkStylesheetsDialog.
  await openMenu(page, 'ch003.xhtml')
  await page.getByRole('menuitem', { name: '关联样式表…' }).click()
  const linkDialog = page.getByRole('dialog', { name: '关联样式表' })
  await expect(linkDialog).toBeVisible()
  await linkDialog.locator('label', { hasText: 'style001.css' }).click()
  await linkDialog.getByRole('button', { name: '应用样式表' }).click()

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('style001.css')

  // Unlink style001.css so it becomes an unused stylesheet, then clean it via CheckPanel -> UnusedResourcesDialog.
  await openMenu(page, 'ch003.xhtml')
  await page.getByRole('menuitem', { name: '关联样式表…' }).click()
  await expect(linkDialog).toBeVisible()
  await linkDialog.locator('label', { hasText: 'style001.css' }).click()
  await linkDialog.getByRole('button', { name: '应用样式表' }).click()

  await page.getByRole('button', { name: '检查' }).click()
  await page.getByRole('button', { name: /清理未引用资源/ }).click()
  const unusedDialog = page.getByRole('dialog', { name: '清理未引用资源' })
  await expect(unusedDialog).toBeVisible()
  await expect(unusedDialog).toContainText('style001.css')
  await unusedDialog.getByRole('button', { name: /删除选中的/ }).click()

  await expect(page.getByRole('button', { name: 'style001.css', exact: true })).toHaveCount(0)
  await expect(page.locator('.structure-toast')).toContainText('已清理')
})
