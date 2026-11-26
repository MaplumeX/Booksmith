import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

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

test('offers the structural actions in the file tree menu', async ({ page }) => {
  await openWorkbench(page)
  await openMenu(page, 'ch003.xhtml')

  for (const label of ['新建章节', '重命名', '删除', '章节上移', '章节下移', '版本历史']) {
    await expect(page.getByRole('menuitem', { name: label })).toBeVisible()
  }
})

test('creates a chapter that survives a save and reload', async ({ page }) => {
  await openWorkbench(page)
  await openMenu(page, 'ch003.xhtml')
  await page.getByRole('menuitem', { name: '新建章节' }).click()

  await expect(page.locator('.tab.on')).toContainText('ch026.xhtml')
  await expect(page.locator('.cm-content')).toContainText('ch026')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ch026.xhtml', exact: true })).toBeVisible()
})

test('renames a chapter and rewrites the table of contents', async ({ page }) => {
  await openWorkbench(page)
  await openMenu(page, 'ch003.xhtml')
  await page.getByRole('menuitem', { name: '重命名' }).click()

  await expect(page.getByRole('dialog', { name: '重命名文件' })).toBeVisible()
  await page.getByLabel('文件名').fill('ch003-intro.xhtml')
  await page.getByRole('button', { name: '重命名' }).click()

  await expect(page.getByRole('button', { name: 'ch003-intro.xhtml', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'ch003-intro.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')

  // The nav document is a plain text entry, so its rewritten href is visible in the editor.
  await page.getByRole('button', { name: 'nav.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('ch003-intro.xhtml')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ch003-intro.xhtml', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ch003.xhtml', exact: true })).toHaveCount(0)
})

test('lists the references before deleting an image', async ({ page }) => {
  await openWorkbench(page)
  await openMenu(page, 'cover.jpg')

  await page.getByRole('menuitem', { name: '删除' }).click()
  await expect(page.getByRole('dialog', { name: '删除文件' })).toBeVisible()
  const references = page.locator('.reference-item')
  await expect(references.first()).toBeVisible()
  await expect(references.filter({ hasText: 'cover.xhtml' })).toHaveCount(1)

  await page.getByRole('button', { name: '删除' }).click()
  await expect(page.getByRole('button', { name: 'cover.jpg', exact: true })).toHaveCount(0)
})

test('moves a chapter within the reading order', async ({ page }) => {
  await openWorkbench(page)
  const before = await chapterOrder(page)
  const chapter = before.indexOf('ch003.xhtml')
  expect(before[chapter - 1]).toBe('ch002.xhtml')

  await openMenu(page, 'ch003.xhtml')
  await page.getByRole('menuitem', { name: '章节上移' }).click()

  const after = await chapterOrder(page)
  expect(after.indexOf('ch003.xhtml')).toBe(after.indexOf('ch002.xhtml') - 1)

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  const reloaded = await chapterOrder(page)
  expect(reloaded.indexOf('ch003.xhtml')).toBe(reloaded.indexOf('ch002.xhtml') - 1)
})

test('supports cross-group multi-select, protects container files, and disables chapter-only actions on mixed selections', async ({
  page,
}) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: '多选文件', exact: true }).click()

  await expect(page.getByLabel('选择 content.opf')).toHaveCount(0)
  await expect(page.getByLabel('content.opf 受保护，不可多选')).toBeVisible()
  await expect(page.getByLabel('选择 container.xml')).toHaveCount(0)

  await page.getByLabel('选择 ch003.xhtml').check()
  await page.getByLabel('选择 cover.jpg').check()
  await expect(page.locator('.tree-batch-count')).toHaveText('已选 2 项')

  await expect(page.getByRole('button', { name: '合并选中章节', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '为选中章节关联样式表', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '批量上移', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '批量重命名', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '批量删除', exact: true })).toBeEnabled()

  await page.keyboard.press('Escape')
  await expect(page.locator('.tree-batch-bar')).toHaveCount(0)
})

test('batch renames with conflict detection, find-replace, chained sequence, undo, and persistence', async ({
  page,
}) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: '多选文件', exact: true }).click()
  await page.getByLabel('选择 ch002.xhtml').check()
  await page.getByLabel('选择 ch003.xhtml').check()
  await page.getByRole('button', { name: '批量重命名', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '批量重命名' })
  await expect(dialog).toBeVisible()
  // Default sequence ch001/ch002 conflicts with unselected ch001.xhtml.
  await expect(dialog.getByRole('alert')).toContainText('冲突')
  await expect(dialog.getByRole('button', { name: '应用重命名', exact: true })).toBeDisabled()

  // Switch to literal find-and-replace and apply.
  await dialog.getByRole('tab', { name: '查找替换' }).click()
  await dialog.getByLabel('查找文本').fill('ch00')
  await dialog.getByLabel('替换为').fill('sec0')
  await expect(dialog.getByRole('button', { name: '应用重命名', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '应用重命名', exact: true }).click()

  await expect(page.getByRole('button', { name: 'sec02.xhtml', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'sec03.xhtml', exact: true })).toBeVisible()
  await expect(page.locator('.structure-toast')).toContainText('已批量重命名 2 个文件')

  // Undo restores original filenames.
  await page.locator('.structure-toast-undo').click()
  await expect(page.getByRole('button', { name: 'ch002.xhtml', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ch003.xhtml', exact: true })).toBeVisible()

  // Chained sequence rename (ch001->ch000, ch002->ch001, ch003->ch002), save, and reload.
  await page.getByLabel('选择 ch001.xhtml').check()
  await page.getByLabel('选择 ch002.xhtml').check()
  await page.getByLabel('选择 ch003.xhtml').check()
  await page.getByRole('button', { name: '批量重命名', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('起始编号').fill('0')
  await expect(dialog.getByRole('button', { name: '应用重命名', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '应用重命名', exact: true }).click()

  await expect(page.getByRole('button', { name: 'ch000.xhtml', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ch000.xhtml', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ch003.xhtml', exact: true })).toHaveCount(0)
})

test('batch deletes across groups with mutual-reference filtering, risk warning, undo, and persistence', async ({
  page,
}) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: '多选文件', exact: true }).click()
  // cover.xhtml references cover.jpg; deleting both together filters out that internal reference.
  await page.getByLabel('选择 cover.xhtml').check()
  await page.getByLabel('选择 cover.jpg').check()
  await page.getByRole('button', { name: '批量删除', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '删除文件' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('alert')).toContainText('封面图')
  await expect(dialog.locator('.reference-item', { hasText: 'cover.xhtml' })).toHaveCount(0)

  await dialog.getByRole('button', { name: '删除 2 个文件' }).click()
  await expect(page.getByRole('button', { name: 'cover.xhtml', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'cover.jpg', exact: true })).toHaveCount(0)

  // Undo restores both files cleanly.
  await page.locator('.structure-toast-undo').click()
  await expect(page.getByRole('button', { name: 'cover.xhtml', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'cover.jpg', exact: true })).toBeVisible()

  // Delete two chapters, save, and reload to verify persistence.
  await page.getByLabel('选择 ch002.xhtml').check()
  await page.getByLabel('选择 ch003.xhtml').check()
  await page.getByRole('button', { name: '批量删除', exact: true }).click()
  await dialog.getByRole('button', { name: '删除 2 个文件' }).click()
  await expect(page.getByRole('button', { name: 'ch002.xhtml', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ch003.xhtml', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ch002.xhtml', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ch003.xhtml', exact: true })).toHaveCount(0)
})

test('batch moves non-contiguous chapters preserving spacing via toolbar, Alt+Arrow, and undo', async ({ page }) => {
  await openWorkbench(page)
  const initial = await chapterOrder(page)
  const idx2 = initial.indexOf('ch002.xhtml')
  const idx4 = initial.indexOf('ch004.xhtml')
  expect(idx2).toBeGreaterThan(0)
  expect(idx4).toBe(idx2 + 2)

  await page.getByRole('button', { name: '多选文件', exact: true }).click()
  await page.getByLabel('选择 ch002.xhtml').check()
  await page.getByLabel('选择 ch004.xhtml').check()

  // Move up via Alt+ArrowUp inside file tree.
  await page.keyboard.press('Alt+ArrowUp')
  const movedUp = await chapterOrder(page)
  expect(movedUp.indexOf('ch002.xhtml')).toBe(idx2 - 1)
  expect(movedUp.indexOf('ch004.xhtml')).toBe(idx4 - 1)
  // Selection stays checked after batch move.
  await expect(page.getByLabel('选择 ch002.xhtml')).toBeChecked()
  await expect(page.getByLabel('选择 ch004.xhtml')).toBeChecked()

  // Move down via Alt+ArrowDown restores exact original order.
  await page.keyboard.press('Alt+ArrowDown')
  expect(await chapterOrder(page)).toEqual(initial)

  // Move up via button, then undo via toast.
  await page.getByRole('button', { name: '批量上移', exact: true }).click()
  expect((await chapterOrder(page)).indexOf('ch002.xhtml')).toBe(idx2 - 1)
  await page.locator('.structure-toast-undo').click()
  expect(await chapterOrder(page)).toEqual(initial)
})
