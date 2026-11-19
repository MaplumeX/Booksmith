import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openToc(page: Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('tab', { name: '目录' }).click()
  await expect(page.locator('.toc-item').first()).toBeVisible()
}

test('adds a toc entry and keeps it after a reload', async ({ page }) => {
  await openToc(page)
  const before = await page.locator('.toc-item').count()

  await page.getByRole('button', { name: '新增条目' }).click()
  await page.getByLabel('目标文件').fill('text/ch003.xhtml')
  await expect(page.getByLabel('标题')).not.toHaveValue('')
  await page.getByRole('button', { name: '添加' }).click()

  const entry = page.locator('.toc-item').nth(before)
  await expect(entry.locator('.toc-label')).not.toBeEmpty()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('tab', { name: '目录' }).click()
  await expect(page.locator('.toc-item')).toHaveCount(before + 1)
  await expect(page.locator('.toc-item').last().locator('.toc-label')).not.toBeEmpty()
})

test('indents an entry under its previous sibling', async ({ page }) => {
  await openToc(page)

  const second = page.locator('.toc-item').nth(1)
  const before = await second.evaluate((element) => parseInt(element.style.paddingLeft || '0', 10))
  await second.getByRole('button', { name: /^缩进/ }).click()

  const after = await page
    .locator('.toc-item')
    .nth(1)
    .evaluate((element) => parseInt(element.style.paddingLeft || '0', 10))
  expect(after).toBe(before + 14)
})

test('refuses to indent the first entry, which has nothing to nest under', async ({ page }) => {
  await openToc(page)
  await expect(page.locator('.toc-item').first().getByRole('button', { name: /^缩进/ })).toBeDisabled()
})

test('outdents a nested entry back one level', async ({ page }) => {
  await openToc(page)

  await page.getByRole('button', { name: '新增条目' }).click()
  await page.getByLabel('目标文件').fill('text/ch003.xhtml')
  await page.getByLabel('标题').fill('临时目录项')
  await page.getByRole('button', { name: '添加' }).click()

  const added = page.locator('.toc-item').filter({ hasText: '临时目录项' })
  const before = await added.evaluate((element) => parseInt(element.style.paddingLeft || '0', 10))
  await added.getByRole('button', { name: /^缩进/ }).click()

  const indented = page.locator('.toc-item').filter({ hasText: '临时目录项' })
  await expect(indented.getByRole('button', { name: /^取消缩进/ })).toBeEnabled()
  await indented.getByRole('button', { name: /^取消缩进/ }).click()

  const after = await page
    .locator('.toc-item')
    .filter({ hasText: '临时目录项' })
    .evaluate((element) => parseInt(element.style.paddingLeft || '0', 10))
  expect(after).toBe(before)
})
