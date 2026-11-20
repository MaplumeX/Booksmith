import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openChapter(page: Page, file: string) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('button', { name: file, exact: true }).click()
  await expect(page.locator('.tab.on')).toContainText(file)
}

test('renders the chapter inside the preview frame', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  const frame = page.frameLocator('.preview-frame')
  await expect(frame.locator('body')).toContainText('序言')
})

test('applies the book stylesheet to the preview', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  const frame = page.frameLocator('.preview-frame')
  const margin = await frame.locator('body').evaluate((body) => getComputedStyle(body).margin)
  // stylesheet1.css sets body { margin: 5% }
  expect(margin).not.toBe('0px')
  expect(parseFloat(margin)).toBeGreaterThan(0)
})

test('renders MathML as real boxes', async ({ page }) => {
  await openChapter(page, 'ch010.xhtml')
  const frame = page.frameLocator('.preview-frame')
  const math = frame.locator('math').first()
  await expect(math).toBeVisible()
  const box = await math.boundingBox()
  expect(box?.width ?? 0).toBeGreaterThan(4)
  expect(box?.height ?? 0).toBeGreaterThan(4)
})

test('loads images from the book archive', async ({ page }) => {
  await openChapter(page, 'cover.xhtml')
  const frame = page.frameLocator('.preview-frame')
  const image = frame.locator('img').first()
  await expect(image).toBeVisible()
  await expect
    .poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
})

test('patches preview in place on code edits and save without reloading the iframe or styles', async ({ page }) => {
  await openChapter(page, 'ch003.xhtml')
  const frame = page.frameLocator('.preview-frame')
  await expect(frame.locator('body')).toContainText('序言')

  await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    const win = iframe.contentWindow as unknown as Record<string, unknown>
    const doc = iframe.contentDocument!
    win.__previewSessionId = 'stable-preview'
    win.__initialStyle = doc.head.querySelector('style')
    win.__initialHeading = doc.body.querySelector('h1')
  })

  // Edit in code mode (multiple keystrokes after already dirty) and verify live preview updates in place.
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('<p>无闪烁实时预览测试</p>')

  await expect(frame.locator('body')).toContainText('无闪烁实时预览测试')

  const afterEdit = await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    const win = iframe.contentWindow as unknown as Record<string, unknown>
    const doc = iframe.contentDocument!
    return {
      sameWindow: win.__previewSessionId === 'stable-preview',
      sameStyle: doc.head.querySelector('style') === win.__initialStyle,
      sameHeading: doc.body.querySelector('h1') === win.__initialHeading,
    }
  })
  expect(afterEdit).toEqual({ sameWindow: true, sameStyle: true, sameHeading: true })

  // Save and verify the preview iframe still did not reload.
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')
  await expect(page.locator('.statusbar')).toContainText('未修改')

  const afterSave = await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    const win = iframe.contentWindow as unknown as Record<string, unknown>
    const doc = iframe.contentDocument!
    return {
      sameWindow: win.__previewSessionId === 'stable-preview',
      sameStyle: doc.head.querySelector('style') === win.__initialStyle,
      sameHeading: doc.body.querySelector('h1') === win.__initialHeading,
    }
  })
  expect(afterSave).toEqual({ sameWindow: true, sameStyle: true, sameHeading: true })
})
