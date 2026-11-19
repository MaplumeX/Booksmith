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

test('opens one file history from its tree context menu', async ({ page }) => {
  await openChapter(page)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: '版本历史' }).click()

  await expect(page.getByRole('dialog', { name: 'ch003.xhtml 的版本历史' })).toBeVisible()
  // Only this file's snapshots: the import baseline, nothing from the other 27 documents.
  await expect(page.locator('.snapshot-item')).toHaveCount(1)
  await expect(page.locator('.snapshot-head')).toContainText('EPUB/text/ch003.xhtml')
})

test('disables history for entries that never get snapshots', async ({ page }) => {
  await openChapter(page)

  await page.getByRole('button', { name: 'cover.jpg', exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '版本历史' })).toBeDisabled()
})

test('shows the diff of the selected version against the current file', async ({ page }) => {
  await openChapter(page)
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>只剩这一句</p></body></html>')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '版本历史' }).click()

  // Newest first: the version saved a moment ago is identical to the editor, so pick the older one.
  await expect(page.locator('.snapshot-item')).toHaveCount(2)
  await page.locator('.snapshot-item').last().click()

  const diff = page.locator('.diff-view')
  await expect(diff).toContainText('只剩这一句')
  await expect(diff).toContainText('序言')
})

test('the top bar version button opens the open file history', async ({ page }) => {
  await openChapter(page)
  await page.locator('.appbar-history').click()
  await expect(page.getByRole('dialog', { name: 'ch003.xhtml 的版本历史' })).toBeVisible()
})
