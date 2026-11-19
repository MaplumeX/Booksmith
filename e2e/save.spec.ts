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

const REWRITTEN_CHAPTER = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE html>',
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>序言</title></head>',
  '<body><h1>序言</h1><p>这段文字被测试改写了，用来验证快照差异。</p></body></html>',
].join('\n')

test('lists snapshots and restores an older one', async ({ page }) => {
  await openChapter(page)
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(REWRITTEN_CHAPTER)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.locator('.appbar-history').click()
  await expect(page.locator('.snapshot-item')).toHaveCount(2)
  await expect(page.locator('.snapshot-item').first()).toContainText('当前')

  await page.locator('.snapshot-item').last().click()
  await page.getByRole('button', { name: '恢复到此快照' }).click()
  await page.getByRole('button', { name: '确认恢复' }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v3')
})
