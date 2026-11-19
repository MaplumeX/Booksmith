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
