import { expect, test } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeAll(async () => {
  bookId = await seedBook()
})

async function openBook(page: import('@playwright/test').Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
}

test('searches the whole book and groups results by file', async ({ page }) => {
  await openBook(page)
  await page.getByRole('tab', { name: '查找' }).click()
  await page.getByLabel('全书查找').fill('置盐定理')

  await expect(page.locator('.search-status')).toContainText('处', { timeout: 15_000 })
  const groups = page.locator('.search-group')
  await expect(groups.first()).toBeVisible()
  expect(await groups.count()).toBeGreaterThan(1)
})

test('opens a hit and reveals it in the editor', async ({ page }) => {
  await openBook(page)
  await page.getByRole('tab', { name: '查找' }).click()
  await page.getByLabel('全书查找').fill('置盐定理')
  await expect(page.locator('.search-group').first()).toBeVisible({ timeout: 15_000 })

  await page.locator('.search-hit').first().click()
  await expect(page.locator('.cm-content')).toContainText('置盐定理')
  await expect(page.locator('.cm-editor')).toHaveClass(/cm-focused/)
})

test('shows an empty state for a term the book does not contain', async ({ page }) => {
  await openBook(page)
  await page.getByRole('tab', { name: '查找' }).click()
  await page.getByLabel('全书查找').fill('这几个字书里肯定没有')

  await expect(page.getByText(/没有匹配/)).toBeVisible({ timeout: 15_000 })
})

test('replaces text in the current file with the editor search panel', async ({ page }) => {
  await openBook(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.locator('.cm-search')
  await expect(panel).toBeVisible()
  await panel.locator('input[name=search]').fill('序言')
  await panel.locator('input[name=replace]').fill('前言')
  await panel.getByRole('button', { name: 'replace all', exact: true }).click()

  await expect(page.locator('.cm-content')).toContainText('前言')
  await expect(page.locator('.statusbar')).toContainText('未保存')
})
