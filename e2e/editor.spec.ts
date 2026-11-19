import { expect, test } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeAll(async () => {
  bookId = await seedBook()
})

async function openWorkbench(page: import('@playwright/test').Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
}

test('groups the book files and opens the first text document', async ({ page }) => {
  await openWorkbench(page)

  await expect(page.getByText('TEXT', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('STYLES', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('IMAGES', { exact: false }).first()).toBeVisible()

  // cover.xhtml is first in the spine, so it opens by default.
  await expect(page.locator('.tab.on')).toContainText('cover.xhtml')
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('opens another chapter and shows its text', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()

  await expect(page.locator('.tab.on')).toContainText('ch003.xhtml')
  await expect(page.locator('.cm-content')).toContainText('序言')
})

test('marks a tab dirty after typing', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')

  await page.locator('.cm-content').click()
  await page.keyboard.type('X')

  await expect(page.locator('.tab.on')).toHaveAttribute('data-dirty', 'true')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')
})

test('closes a tab and falls back to the remaining one', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.tab')).toHaveCount(2)

  await page.getByRole('button', { name: '关闭 ch003.xhtml' }).click()
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab.on')).toContainText('cover.xhtml')
})
