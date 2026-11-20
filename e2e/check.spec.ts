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

test('reports nothing for an intact book', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: '检查' }).click()
  await expect(page.locator('.check-popover')).toContainText('没有发现问题')
})

test('reports a broken reference and jumps to it', async ({ page }) => {
  await openWorkbench(page)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('<img src="../images/nope.png"/>')

  await page.getByRole('button', { name: '检查' }).click()
  await expect(page.locator('.check-group-label')).toContainText('错误')
  await expect(page.locator('.check-item')).toContainText('引用的文件不存在')
  await expect(page.locator('.check-path')).toContainText('ch003.xhtml')

  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'ch004.xhtml', exact: true }).click()
  await page.getByRole('button', { name: '检查' }).click()
  await page.locator('.check-item').first().click()
  await expect(page.locator('.tab.on')).toContainText('ch003.xhtml')
})

test('clears the issue once the reference is fixed', async ({ page }) => {
  await openWorkbench(page)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('<img src="../images/nope.png"/>')

  await page.getByRole('button', { name: '检查' }).click()
  await expect(page.locator('.check-item')).toHaveCount(1)

  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await page.getByRole('button', { name: '检查' }).click()
  await expect(page.locator('.check-popover')).toContainText('没有发现问题')
})
