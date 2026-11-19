import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openChapter(page: Page, file = 'ch003.xhtml') {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: file, exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')
}

test('saves edits and bumps the version', async ({ page }) => {
  await openChapter(page)
  await expect(page.locator('.appbar-meta')).toHaveText('v1')

  await page.locator('.cm-content').click()
  await page.keyboard.type('X')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  // A reload shows the saved text, proving the round trip reached the server.
  // Reload resets the open tab to the first document, so reopen the chapter.
  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
})

test('reports a conflict when another tab saved first', async ({ context, page }) => {
  await openChapter(page)
  await page.locator('.cm-content').click()
  await page.keyboard.type('A')

  const second = await context.newPage()
  await second.goto(`/books/${bookId}`)
  await second.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(second.locator('.cm-content')).toContainText('序言')
  await second.locator('.cm-content').click()
  await second.keyboard.type('B')
  await second.getByRole('button', { name: '保存', exact: true }).click()
  await expect(second.locator('.appbar-meta')).toHaveText('v2')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('在别处已更新')
  await expect(page.locator('.appbar-meta')).toHaveText('v1')
})

test('lists versions and restores an older one', async ({ page }) => {
  await openChapter(page)
  await page.locator('.cm-content').click()
  await page.keyboard.type('X')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.getByRole('tab', { name: '版本' }).click()
  await expect(page.locator('.version-item')).toHaveCount(2)
  await expect(page.locator('.version-item').first()).toContainText('v2')

  await page.getByRole('button', { name: '恢复此版本' }).last().click()
  await page.getByRole('button', { name: '确认恢复' }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v3')
})
