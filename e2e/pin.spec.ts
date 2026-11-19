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

async function openHistory(page: Page, file = 'ch003.xhtml') {
  await page.getByRole('button', { name: file, exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '版本历史' }).click()
  await expect(page.getByRole('dialog', { name: `${file} 的版本历史` })).toBeVisible()
}

test('pins a snapshot and keeps it pinned after a reload', async ({ page }) => {
  await openWorkbench(page)
  await openHistory(page)

  const pin = page.locator('.snapshot-pin').first()
  await expect(pin).toHaveAttribute('aria-pressed', 'false')
  await pin.click()
  await expect(pin).toHaveAttribute('aria-pressed', 'true')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await openHistory(page)
  await expect(page.locator('.snapshot-pin').first()).toHaveAttribute('aria-pressed', 'true')
})

test('unpins a snapshot', async ({ page }) => {
  await openWorkbench(page)
  await openHistory(page)

  const pin = page.locator('.snapshot-pin').first()
  await pin.click()
  await expect(pin).toHaveAttribute('aria-pressed', 'true')
  await pin.click()
  await expect(pin).toHaveAttribute('aria-pressed', 'false')
})
