import { unzipArchive, zipArchive } from '../packages/core/src/zip'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { API, E2E_EMAIL, E2E_PASSWORD, expectLoggedIn, FIXTURE, login, resetLibrary, seedBook } from './helpers'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

async function seedCrlfBook(targetPaths: string[]): Promise<string> {
  await resetLibrary()
  const raw = new Uint8Array(readFileSync(FIXTURE))
  const archive = unzipArchive(raw)
  const entries = new Map(archive.entries)
  for (const path of targetPaths) {
    const data = entries.get(path)
    if (!data) throw new Error(`fixture missing ${path}`)
    const text = decoder.decode(data).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')
    entries.set(path, encoder.encode(text))
  }
  const bytes = zipArchive({ order: archive.order, entries })

  const context = await playwrightRequest.newContext({ baseURL: API })
  const res = await context.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  if (!res.ok()) throw new Error(`seed login failed: ${res.status()}`)
  const upload = await context.post('/api/books', {
    headers: { 'content-type': 'application/epub+zip' },
    data: Buffer.from(bytes),
  })
  if (!upload.ok()) throw new Error(`seed upload failed: ${upload.status()} ${await upload.text()}`)
  const body = (await upload.json()) as { book: { id: string } }
  await context.dispose()
  return body.book.id
}

async function readSavedEntryText(bookId: string, entryPath: string): Promise<string> {
  const context = await playwrightRequest.newContext({ baseURL: API })
  const res = await context.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  if (!res.ok()) throw new Error(`download login failed: ${res.status()}`)
  const download = await context.get(`/api/books/${bookId}/download`)
  if (!download.ok()) throw new Error(`download failed: ${download.status()}`)
  const archive = unzipArchive(new Uint8Array(await download.body()))
  await context.dispose()
  const bytes = archive.entries.get(entryPath)
  if (!bytes) throw new Error(`saved epub missing ${entryPath}`)
  return decoder.decode(bytes)
}

async function openBook(page: Page, bookId: string) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
}

test('opening CRLF chapters and switching tabs or modes does not mark files dirty', async ({ page }) => {
  const bookId = await seedCrlfBook(['EPUB/text/ch003.xhtml', 'EPUB/text/ch004.xhtml'])
  await openBook(page, bookId)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')
  await expect(page.locator('.statusbar')).toContainText('未修改')
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()

  await page.getByRole('button', { name: 'ch004.xhtml', exact: true }).click()
  await expect(page.locator('.tab.on')).toContainText('ch004.xhtml')
  await expect(page.locator('.statusbar')).toContainText('未修改')
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0)

  await page.getByRole('button', { name: '可视化', exact: true }).click()
  await expect(page.locator('.wysiwyg-pane')).toBeVisible()
  await page.getByRole('button', { name: '代码', exact: true }).click()
  await expect(page.locator('.statusbar')).toContainText('未修改')
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0)

  // Wait past DRAFT_DEBOUNCE_MS and reload to ensure no ghost local draft was written.
  await page.waitForTimeout(1300)
  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.locator('.banner-info')).toHaveCount(0)
})

test('editing and saving a CRLF chapter preserves CRLF line endings', async ({ page }) => {
  const bookId = await seedCrlfBook(['EPUB/text/ch003.xhtml'])
  await openBook(page, bookId)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  await page.locator('.cm-content').click()
  await page.keyboard.type('CRLF保留测试')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  const saved = await readSavedEntryText(bookId, 'EPUB/text/ch003.xhtml')
  expect(saved).toContain('CRLF保留测试')
  expect(saved).toContain('\r\n')
  expect(saved.replace(/\r\n/g, '')).not.toContain('\n')
})

test('undoing back to saved content clears dirty state and local draft', async ({ page }) => {
  const bookId = await seedBook()
  await openBook(page, bookId)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')

  await page.locator('.cm-content').click()
  await page.keyboard.type('临时改动')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')
  await page.waitForTimeout(1300)

  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.cm-content')).not.toContainText('临时改动')
  await expect(page.locator('.statusbar')).toContainText('未修改')
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.locator('.banner-info')).toHaveCount(0)
})

test('saving in WYSIWYG mode and switching back to code stays clean', async ({ page }) => {
  const bookId = await seedBook()
  await openBook(page, bookId)

  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await page.getByRole('button', { name: '可视化', exact: true }).click()

  const frame = page.frameLocator('.wysiwyg-frame')
  const firstPara = frame.locator('p').first()
  await expect(firstPara).toBeVisible()
  await firstPara.click()
  await page.keyboard.type('可视化已存')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  await page.getByRole('button', { name: '代码', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('可视化已存')
  await expect(page.locator('.statusbar')).toContainText('未修改')
  await expect(page.locator('.tab[data-dirty="true"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
})

test('replaces binary asset without dirtying OPF and marks deletions saveable', async ({ page }) => {
  const bookId = await seedBook()
  await openBook(page, bookId)

  const imageRow = page.getByRole('button', { name: 'file0.jpg', exact: true })
  const opfRow = page.getByRole('button', { name: 'content.opf', exact: true })

  await imageRow.click()
  await expect(page.locator('.media-meta').first()).toBeVisible()
  await page.locator('.media-actions').first().getByRole('button', { name: '替换图片' }).click()
  await page.locator('.media-pane input[type=file]').first().setInputFiles({
    name: 'replacement.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  })
  const replaceDialog = page.getByRole('dialog', { name: '替换图片' })
  await expect(replaceDialog).toBeVisible()
  await replaceDialog.getByRole('button', { name: '替换' }).click()

  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')
  await expect(imageRow.locator('.dirty-dot')).toHaveCount(1)
  await expect(opfRow.locator('.dirty-dot')).toHaveCount(0)

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  // Deleting the image must mark the book unsaved and allow saving the deletion.
  await page.locator('.media-actions').first().getByRole('button', { name: '删除' }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除文件' })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: '删除' }).click()

  await expect(imageRow).toHaveCount(0)
  await expect(page.locator('.statusbar')).toContainText('未保存')
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v3')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await expect(page.getByRole('button', { name: 'file0.jpg', exact: true })).toHaveCount(0)
})
