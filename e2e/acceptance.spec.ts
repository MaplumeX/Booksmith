import { expect, test } from '@playwright/test'
import { expectLoggedIn, login, resetLibrary } from './helpers'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.beforeEach(async () => {
  await resetLibrary()
})

test('creates a new book, edits it and saves a version', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)

  await page.getByRole('button', { name: '新建书' }).click()
  await page.getByRole('dialog').getByLabel('书名', { exact: true }).fill('新建测试书')
  await page.getByRole('dialog').getByLabel('作者（可留空）').fill('测试作者')
  await page.getByRole('button', { name: '创建并打开' }).click()

  await expect(page).toHaveURL(/\/books\/[0-9a-f-]{36}$/)
  await expect(page.locator('.appbar-title')).toHaveText('新建测试书')
  await expect(page.locator('.cm-content')).toContainText('从这里开始写。')

  await page.locator('.cm-content').click()
  await page.keyboard.type('补一段。')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.getByRole('button', { name: '← 书库' }).click()
  await expect(page.getByText('新建测试书')).toBeVisible()
})

test('imports an image asset into the package', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)

  await page.getByRole('button', { name: '新建书' }).click()
  await page.getByRole('dialog').getByLabel('书名', { exact: true }).fill('资源测试书')
  await page.getByRole('button', { name: '创建并打开' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  await page.setInputFiles('[data-testid=asset-input]', {
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  })

  await expect(page.getByRole('button', { name: 'cover.png', exact: true })).toBeVisible()
  await expect(page.locator('.statusbar')).toContainText('未保存')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.getByRole('button', { name: 'cover.png', exact: true })).toBeVisible()
})

test('restores a version from the versions tab', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)

  await page.getByRole('button', { name: '新建书' }).click()
  await page.getByRole('dialog').getByLabel('书名', { exact: true }).fill('版本测试书')
  await page.getByRole('button', { name: '创建并打开' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  await page.locator('.cm-content').click()
  await page.keyboard.type('第一次修改。')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.getByRole('tab', { name: '版本' }).click()
  await expect(page.locator('.version-item')).toHaveCount(2)
})
