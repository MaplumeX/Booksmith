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

test('undoes typing made before a tab switch', async ({ page }) => {
  await openWorkbench(page)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')
  await page.locator('.cm-content').click()
  await page.keyboard.type('撤销测试标记')
  await expect(page.locator('.cm-content')).toContainText('撤销测试标记')

  await page.getByRole('button', { name: 'ch004.xhtml', exact: true }).click()
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()

  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')

  await expect(page.locator('.cm-content')).not.toContainText('撤销测试标记')
})

test('restores the caret position along with the undo stack', async ({ page }) => {
  await openWorkbench(page)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('末尾')
  await page.keyboard.press('Home')

  await page.getByRole('button', { name: 'ch004.xhtml', exact: true }).click()
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()

  // The selection survived the switch, so typing lands at the line start the caret was moved to.
  await page.keyboard.type('行首')
  await expect(page.locator('.cm-content')).toContainText('行首')
})
