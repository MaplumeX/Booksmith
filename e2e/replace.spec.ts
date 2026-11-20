import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openSearch(page: Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: '查找', exact: true }).click()
  await page.getByLabel('全书查找').fill('马克思')
  await expect(page.locator('.search-status')).toContainText('个文件')
}

test('replaces across the whole book and persists through a save', async ({ page }) => {
  await openSearch(page)

  await page.getByLabel('替换为').fill('马克斯')
  await page.getByRole('button', { name: '替换全部' }).click()
  await expect(page.locator('.search-confirm')).toContainText('将替换')

  await page.getByRole('button', { name: '执行' }).click()
  await expect(page.locator('.search-confirm')).toContainText('已替换')
  await expect(page.locator('.search-status')).toContainText('0 处')
  await expect(page.locator('.appbar-flag')).toContainText('未保存')
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: '查找', exact: true }).click()
  await page.getByLabel('全书查找').fill('马克思')
  await expect(page.locator('.search-status')).toContainText('0 处')
  await page.getByLabel('全书查找').fill('马克斯')
  await expect(page.locator('.search-status')).not.toContainText('0 处')
})

test('undoes a replace batch in one click', async ({ page }) => {
  await openSearch(page)

  await page.getByLabel('替换为').fill('马克斯')
  await page.getByRole('button', { name: '替换全部' }).click()
  await page.getByRole('button', { name: '执行' }).click()
  await expect(page.locator('.search-status')).toContainText('0 处')

  await page.getByRole('button', { name: '撤销' }).click()
  await expect(page.locator('.search-status')).not.toContainText('0 处')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  // Nothing was saved, so the book went back to being untouched.
  await expect(page.locator('.status-right')).toContainText('未修改')
})

test('does nothing when the query has no match', async ({ page }) => {
  await openSearch(page)

  await page.getByLabel('全书查找').fill('这本书里没有的词')
  await expect(page.locator('.search-status')).toContainText('0 处')
  await page.getByLabel('替换为').fill('x')
  await page.getByRole('button', { name: '替换全部' }).click()

  await expect(page.locator('.search-confirm')).toHaveCount(0)
})
