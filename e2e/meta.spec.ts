import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openMetadata(page: Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: '元数据', exact: true }).click()
  await expect(page.locator('.meta-row').first()).toBeVisible()
}

test('adds a meta row and keeps it after a reload', async ({ page }) => {
  await openMetadata(page)
  const before = await page.locator('.meta-row').count()

  await page.getByRole('button', { name: '加一行 meta' }).click()
  const row = before + 1
  await page.getByLabel(`meta ${row} property`).fill('ibooks:specified-fonts')
  await page.getByLabel(`meta ${row} 值`).fill('true')
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: '元数据', exact: true }).click()
  await expect(page.locator('.meta-row')).toHaveCount(row)
  await expect(page.getByLabel(`meta ${row} property`)).toHaveValue('ibooks:specified-fonts')
  await expect(page.getByLabel(`meta ${row} 值`)).toHaveValue('true')
})

test('refreshes dcterms:modified only when the package document changes', async ({ page }) => {
  await openMetadata(page)
  const modified = page.getByLabel('meta 4 值')
  const original = await modified.inputValue()
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  // A prose-only edit leaves the package document alone.
  await page.locator('.cm-content').click()
  await page.keyboard.type('X')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.getByRole('button', { name: '元数据', exact: true }).click()
  await expect(page.getByLabel('meta 4 值')).toHaveValue(original)

  // Editing a dc field is a package change, so the timestamp follows on save.
  await page.getByLabel('书名').fill('马克思经济学与数理分析（第二版）')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v3')

  await page.getByRole('button', { name: '元数据', exact: true }).click()
  await expect(page.getByLabel('meta 4 值')).not.toHaveValue(original)
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: '元数据', exact: true }).click()
  await expect(page.getByLabel('meta 4 值')).not.toHaveValue(original)
})
