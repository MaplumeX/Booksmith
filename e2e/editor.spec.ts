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

test('word-wrapped partial selection only highlights the selected visual row, not the entire wrapped line', async ({
  page,
}) => {
  await openWorkbench(page)
  await page.getByRole('button', { name: 'ch003.xhtml', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('序言')

  // Find a wrapped `.cm-line` (height >= 2x single line height) and drag-select a short slice inside its second visual row.
  const wrappedInfo = await page.evaluate(() => {
    const lines = [...document.querySelectorAll<HTMLElement>('.cm-line')]
    const singleHeight = lines[0]!.getBoundingClientRect().height
    const wrapped = lines.find((el) => el.getBoundingClientRect().height >= singleHeight * 2.5)
    if (!wrapped) return null
    const rect = wrapped.getBoundingClientRect()
    return {
      singleHeight,
      lineTop: rect.top,
      lineBottom: rect.bottom,
      lineHeight: rect.height,
      lineLeft: rect.left,
      lineWidth: rect.width,
    }
  })
  expect(wrappedInfo).not.toBeNull()
  const info = wrappedInfo!

  // Drag horizontally across ~90px in the middle of the second visual row.
  const y = info.lineTop + info.singleHeight * 1.5
  const startX = info.lineLeft + 60
  const endX = info.lineLeft + 150
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(endX, y, { steps: 6 })
  await page.mouse.up()

  await expect(page.locator('.cm-selectionBackground')).toHaveCount(1)

  const singleRowResult = await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>('.cm-selectionBackground')!
    const m = marker.getBoundingClientRect()
    return { top: m.top, bottom: m.bottom, height: m.height, left: m.left, width: m.width }
  })

  // Must match one visual row (not the entire multi-row `.cm-line`), and stay within the dragged horizontal span.
  expect(Math.abs(singleRowResult.height - info.singleHeight)).toBeLessThan(1.5)
  expect(singleRowResult.height).toBeLessThan(info.lineHeight * 0.6)
  expect(singleRowResult.top).toBeGreaterThan(info.lineTop + info.singleHeight * 0.5)
  expect(singleRowResult.bottom).toBeLessThan(info.lineBottom - info.singleHeight * 0.5)
  expect(singleRowResult.width).toBeGreaterThan(40)
  expect(singleRowResult.width).toBeLessThan(info.lineWidth * 0.5)

  // Now drag across 3 visual rows within the same wrapped line: middle `between` rectangle must not expand onto row 1 or row 3.
  const startY3 = info.lineTop + info.singleHeight * 0.5
  const endY3 = info.lineTop + info.singleHeight * 2.5
  await page.mouse.move(info.lineLeft + 180, startY3)
  await page.mouse.down()
  await page.mouse.move(info.lineLeft + 100, endY3, { steps: 8 })
  await page.mouse.up()

  await expect(page.locator('.cm-selectionBackground')).toHaveCount(3)

  const multiRowRects = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.cm-selectionBackground')]
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, width: r.width }
      })
      .sort((a, b) => a.top - b.top),
  )

  expect(multiRowRects).toHaveLength(3)
  // Row 0, Row 1 (between), Row 2 should each be ~1 visual row tall and meet seamlessly with zero overlap or gap.
  for (const r of multiRowRects) {
    expect(Math.abs(r.height - info.singleHeight)).toBeLessThan(1.5)
  }
  expect(Math.abs(multiRowRects[0]!.bottom - multiRowRects[1]!.top)).toBeLessThan(0.5)
  expect(Math.abs(multiRowRects[1]!.bottom - multiRowRects[2]!.top)).toBeLessThan(0.5)
  // Top piece starts to the right of the line's left edge; bottom piece ends before the line's right edge.
  expect(multiRowRects[0]!.left).toBeGreaterThan(info.lineLeft + 100)
  expect(multiRowRects[2]!.width).toBeLessThan(info.lineWidth * 0.5)
})
