import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openBook(page: Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
}

test('edits metadata and persists it through a save', async ({ page }) => {
  await openBook(page)
  await page.getByRole('tab', { name: '元数据' }).click()

  const title = page.getByLabel('书名')
  await expect(title).toHaveValue('马克思经济学与数理分析')
  await title.fill('马克思经济学与数理分析（修订版）')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.locator('.appbar-title')).toHaveText('马克思经济学与数理分析（修订版）')
})

test('lists the real table of contents with anchors intact', async ({ page }) => {
  await openBook(page)
  await page.getByRole('tab', { name: '目录' }).click()

  await expect(page.locator('.toc-item')).toHaveCount(177)
  await expect(page.locator('.toc-item').first()).toContainText('封面')
  await expect(page.getByText('锚点失效')).toHaveCount(0)
})

test('renames a toc entry and mirrors it into the ncx', async ({ page }) => {
  await openBook(page)
  await page.getByRole('tab', { name: '目录' }).click()

  const third = page.locator('.toc-item').nth(3)
  await third.locator('.toc-label').click()
  const input = third.locator('.toc-edit')
  await input.fill('新的序言标题')
  await input.press('Enter')

  await expect(page.locator('.statusbar')).toContainText('2 个文件未保存')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('tab', { name: '目录' }).click()
  await expect(page.locator('.toc-item').nth(3)).toContainText('新的序言标题')
})
