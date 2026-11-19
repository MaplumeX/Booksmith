import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openImage(page: Page, file = 'file0.jpg') {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: file, exact: true }).click()
  await expect(page.locator('.media-meta').first()).toBeVisible()
}

test('replaces an image in place and keeps it after a save', async ({ page }) => {
  await openImage(page)
  const before = await page.locator('.media-meta').first().textContent()

  await page.locator('.media-actions').first().getByRole('button', { name: '替换图片' }).click()
  await page.locator('.media-pane input[type=file]').first().setInputFiles({
    name: 'replacement.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  })

  const dialog = page.getByRole('dialog', { name: '替换图片' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '替换' }).click()

  const after = page.locator('.media-meta').first()
  await expect(after).not.toHaveText(before ?? '')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: 'file0.jpg', exact: true }).click()
  await expect(page.locator('.media-meta').first()).not.toHaveText(before ?? '')
})

test('deletes an image from the media pane', async ({ page }) => {
  await openImage(page)

  await page.locator('.media-actions').first().getByRole('button', { name: '删除' }).click()
  const dialog = page.getByRole('dialog', { name: '删除文件' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '删除' }).click()

  await expect(page.getByRole('button', { name: 'file0.jpg', exact: true })).toHaveCount(0)
})
