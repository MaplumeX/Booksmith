import { expect, test } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.beforeAll(async () => {
  bookId = await seedBook()
})

async function openWorkbench(page: import('@playwright/test').Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
}

test('groups the book files and opens the first text document', async ({ page }) => {
  await openWorkbench(page)

  await expect(page.getByText('TEXT', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('STYLES', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('IMAGES', { exact: false }).first()).toBeVisible()

  // cover.xhtml is first in the spine, so it opens by default.
  await expect(page.locator('.tab.on')).toContainText('cover.xhtml')
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('opens another chapter and shows its text', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()

  await expect(page.locator('.tab.on')).toContainText('ch003.xhtml')
  await expect(page.locator('.cm-content')).toContainText('序言')
})

test('marks a tab dirty after typing', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')

  await page.locator('.cm-content').click()
  await page.keyboard.type('X')

  await expect(page.locator('.tab.on')).toHaveAttribute('data-dirty', 'true')
  await expect(page.locator('.statusbar')).toContainText('1 个文件未保存')
})

test('closes a tab and falls back to the remaining one', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.tab')).toHaveCount(2)

  await page.getByRole('button', { name: '关闭 ch003.xhtml' }).click()
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab.on')).toContainText('cover.xhtml')
})

test('shows an image entry in the content area instead of an empty editor', async ({ page }) => {
  await openWorkbench(page)

  await page.setInputFiles('[data-testid=asset-input]', {
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  })
  await page.getByRole('button', { name: 'cover.png', exact: true }).click()

  await expect(page.locator('.tab.on')).toContainText('cover.png')
  await expect(page.locator('.code-pane')).toHaveCount(0)
  const image = page.locator('.media-image')
  await expect(image).toBeVisible()
  await expect
    .poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
  await expect(page.locator('.statusbar')).not.toContainText('字')
})

test('selection background covers whole line boxes, including wrapped lines', async ({ page }) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')

  await page.locator('.cm-line').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.cm-selectionBackground')).toHaveCount(2)

  // 选区块必须与行盒逐像素对齐：任何缝隙或多出的高度都说明对齐逻辑失效了。
  const gaps = await page.evaluate(() => {
    const marker = document.querySelector('.cm-selectionBackground')!
    const line = document.querySelector('.cm-line')!
    const m = marker.getBoundingClientRect()
    const l = line.getBoundingClientRect()
    return { top: m.top - l.top, bottom: m.bottom - l.bottom }
  })
  expect(Math.abs(gaps.top)).toBeLessThan(0.5)
  expect(Math.abs(gaps.bottom)).toBeLessThan(0.5)
})
