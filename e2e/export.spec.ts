import { readFileSync } from 'node:fs'
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

test('downloads the saved pack with the book title as filename', async ({ page }) => {
  await openWorkbench(page)

  const started = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载' }).click()
  const download = await started

  expect(download.suggestedFilename()).toBe('马克思经济学与数理分析.epub')
  const file = await download.path()
  expect(file).not.toBeNull()
  const bytes = readFileSync(file!)
  // A zip local file header, i.e. the download is the pack itself and not an error page.
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  expect(bytes.byteLength).toBeGreaterThan(600_000)
})

test('warns that unsaved edits are not part of the download', async ({ page }) => {
  await openWorkbench(page)
  await page.locator('.cm-content').click()
  await page.keyboard.type('X')

  await expect(page.getByRole('link', { name: '下载' })).toHaveAttribute('title', /未保存/)
})

test('downloads from the library card', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)

  const started = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载' }).click()
  const download = await started

  expect(download.suggestedFilename()).toBe('马克思经济学与数理分析.epub')
})
