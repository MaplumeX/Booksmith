import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

function readZipCentralDirectory(bytes: Uint8Array): Array<{ name: string; method: number; uncompressedSize: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder('utf-8')
  const items: Array<{ name: string; method: number; uncompressedSize: number }> = []
  for (let i = 0; i <= bytes.byteLength - 46; i += 1) {
    if (view.getUint32(i, true) !== 0x02014b50) continue
    const method = view.getUint16(i + 10, true)
    const uncompressedSize = view.getUint32(i + 24, true)
    const nameLen = view.getUint16(i + 28, true)
    const name = decoder.decode(bytes.subarray(i + 46, i + 46 + nameLen))
    items.push({ name, method, uncompressedSize })
  }
  return items
}

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

test('loads images lazily via /entry in MediaPane and srcDoc preview, renames via JSON without uploading bytes, and exports valid epub', async ({
  page,
}) => {
  const entryResponses: Array<{ url: string; status: number }> = []
  const patchRequests: Array<{ contentType: string; postData: string | null }> = []

  page.on('response', (res) => {
    if (res.url().includes(`/api/books/${bookId}/entry`)) {
      entryResponses.push({ url: res.url(), status: res.status() })
    }
  })
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && req.url().includes(`/api/books/${bookId}/entries`)) {
      patchRequests.push({
        contentType: req.headers()['content-type'] ?? '',
        postData: req.postData(),
      })
    }
  })

  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()

  // Verify PreviewPane srcDoc iframe loads authenticated lazy image via /entry with real pixels.
  await page.getByRole('button', { name: 'cover.xhtml', exact: true }).click()
  const previewFrame = page.frameLocator('iframe.preview-frame')
  const previewImg = previewFrame.locator('img').first()
  await expect(previewImg).toBeVisible()
  await expect
    .poll(() =>
      previewImg.evaluate((el) => {
        const img = el as HTMLImageElement
        return img.complete && img.naturalWidth > 0 && img.src.includes('/api/books/')
      }),
    )
    .toBe(true)
  expect(entryResponses.some((r) => r.status === 200)).toBe(true)

  // Verify MediaPane renders the image lazily via /entry.
  await page.getByRole('button', { name: 'file0.jpg', exact: true }).click()
  const mediaImg = page.locator('.media-image').first()
  await expect(mediaImg).toBeVisible()
  await expect
    .poll(() =>
      mediaImg.evaluate((el) => {
        const img = el as HTMLImageElement
        return img.complete && img.naturalWidth > 0 && img.src.includes('/api/books/')
      }),
    )
    .toBe(true)

  // Rename file0.jpg via file tree context menu and save: must use JSON delta (zero binary upload).
  await page.getByRole('button', { name: 'file0.jpg', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名' }).click()
  const renameDialog = page.getByRole('dialog', { name: '重命名文件' })
  await expect(renameDialog).toBeVisible()
  await renameDialog.getByLabel('文件名').fill('cover_renamed.jpg')
  await renameDialog.getByRole('button', { name: '重命名' }).click()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  expect(patchRequests).toHaveLength(1)
  expect(patchRequests[0]?.contentType).toContain('application/json')
  const body = JSON.parse(patchRequests[0]?.postData ?? '{}') as {
    renames?: Array<{ from: string; to: string }>
  }
  expect(body.renames).toContainEqual({
    from: 'EPUB/media/file0.jpg',
    to: 'EPUB/media/cover_renamed.jpg',
  })

  // Exported EPUB packs directly from book_entries with the renamed image intact.
  const started = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载' }).click()
  const download = await started
  const file = await download.path()
  expect(file).not.toBeNull()
  const zipEntries = readZipCentralDirectory(new Uint8Array(readFileSync(file!)))
  expect(zipEntries[0]?.name).toBe('mimetype')
  expect(zipEntries[0]?.method).toBe(0)
  const renamed = zipEntries.find((e) => e.name === 'EPUB/media/cover_renamed.jpg')
  expect(renamed).toBeTruthy()
  expect(renamed?.method).toBe(0)
  expect(renamed?.uncompressedSize).toBeGreaterThan(1000)
  expect(zipEntries.some((e) => e.name === 'EPUB/media/file0.jpg')).toBe(false)
})
