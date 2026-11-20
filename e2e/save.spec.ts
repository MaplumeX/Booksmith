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

test('restores one page from its own snapshot history', async ({ page }) => {
  await openChapter(page)
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(REWRITTEN_CHAPTER)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.locator('.appbar-history').click()
  // The chapter has the snapshot taken at import plus the one this test just saved.
  await expect(page.locator('.snapshot-item')).toHaveCount(2)
  await expect(page.locator('.snapshot-item').first()).toContainText('最新')

  await page.locator('.snapshot-item').last().click()
  await page.getByRole('button', { name: '恢复这一版' }).click()
  await page.getByRole('button', { name: '确认恢复' }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v3')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).not.toContainText('这段文字被测试改写了')
})

test('saves by itself once typing stops', async ({ page }) => {
  test.setTimeout(70_000)
  await openChapter(page)
  await page.locator('.cm-content').click()
  await page.keyboard.type('自动保存')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')

  await expect(page.locator('.appbar-save')).toHaveText(/已保存 \d{2}:\d{2}/, { timeout: 40_000 })
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  // Nothing was edited after the save, so the timer must not produce another version.
  await page.waitForTimeout(5000)
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
})

test('brings back an unsaved draft after a reload', async ({ page }) => {
  await openChapter(page)
  await page.locator('.cm-content').click()
  await page.keyboard.insertText('本地草稿标记')
  // The draft lands in IndexedDB a second after the last keystroke, long before the 20s autosave.
  await page.waitForTimeout(1500)

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()

  const banner = page.locator('.banner-info')
  await expect(banner).toContainText('本地草稿')
  await banner.getByRole('button', { name: '恢复草稿' }).click()

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('本地草稿标记')
  await expect(page.locator('.statusbar')).toContainText('未保存')
})

test('opens via /workspace without /epub and saves text edits as incremental JSON delta', async ({ page }) => {
  const requests: Array<{ method: string; url: string; contentType: string; postData: string | null }> = []
  page.on('request', (req) => {
    if (req.url().includes(`/api/books/${bookId}`)) {
      requests.push({
        method: req.method(),
        url: req.url(),
        contentType: req.headers()['content-type'] ?? '',
        postData: req.postData(),
      })
    }
  })

  await openChapter(page)
  expect(requests.some((r) => r.method === 'GET' && r.url.includes('/workspace'))).toBe(true)
  expect(requests.some((r) => r.url.endsWith('/epub'))).toBe(false)

  await page.locator('.cm-content').click()
  await page.keyboard.type('增量保存')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  const patch = requests.find((r) => r.method === 'PATCH' && r.url.includes('/entries'))
  expect(patch).toBeTruthy()
  expect(patch?.contentType).toContain('application/json')
  const parsed = JSON.parse(patch?.postData ?? '{}') as {
    textUpserts?: Record<string, string>
    renames?: unknown[]
    deletes?: unknown[]
  }
  expect(Object.keys(parsed.textUpserts ?? {})).toEqual(['EPUB/text/ch003.xhtml'])
  expect(parsed.textUpserts?.['EPUB/text/ch003.xhtml']).toContain('增量保存')
  expect(parsed.renames).toEqual([])
  expect(parsed.deletes).toEqual([])
})
