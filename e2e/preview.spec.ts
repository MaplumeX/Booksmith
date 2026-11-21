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
  const scrollableMathCount = await frame.locator('math').evaluateAll((els) =>
    els.filter((el) => {
      const style = getComputedStyle(el)
      return style.overflowY !== 'visible' || style.overflowX !== 'visible'
    }).length,
  )
  expect(scrollableMathCount).toBe(0)
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

test('applies reader baseline styles and adapts hardcoded grey quotes in dark mode without reloading iframe', async ({
  page,
}) => {
  await openChapter(page, 'ch003.xhtml')
  const frame = page.frameLocator('.preview-frame')
  await expect(frame.locator('body')).toContainText('序言')

  await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    ;(iframe.contentWindow as unknown as Record<string, unknown>).__previewSessionId = 'theme-stable'
  })

  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.insertText(
    '<blockquote id="base-quote"><p>基线引用</p></blockquote>' +
      '<blockquote id="grey-quote" style="color: #555; background: #f5f5f5;"><p>灰字引用</p></blockquote>' +
      '<pre><code>let x = 1;</code></pre>' +
      '<table><tr><th>列</th></tr><tr><td>值</td></tr></table>',
  )

  await expect(frame.locator('#base-quote')).toBeVisible()
  const lightMetrics = await frame.locator('body').evaluate(() => {
    const baseQuote = getComputedStyle(document.getElementById('base-quote')!)
    const greyQuote = getComputedStyle(document.getElementById('grey-quote')!)
    const pre = getComputedStyle(document.querySelector('pre')!)
    const th = getComputedStyle(document.querySelector('th')!)
    return {
      quoteBg: baseQuote.backgroundColor,
      quoteBorderLeft: baseQuote.borderLeftWidth,
      baseMarginBottom: baseQuote.marginBottom,
      baseBottomRightRadius: baseQuote.borderBottomRightRadius,
      greyMarginTop: greyQuote.marginTop,
      greyTopRightRadius: greyQuote.borderTopRightRadius,
      preBg: pre.backgroundColor,
      thBg: th.backgroundColor,
    }
  })
  expect(lightMetrics.quoteBg).toBe('rgb(244, 244, 246)')
  expect(lightMetrics.quoteBorderLeft).toBe('3px')
  // Adjacent blockquotes stitch seamlessly without an inter-card gap or seam corner radius.
  expect(lightMetrics.baseMarginBottom).toBe('0px')
  expect(lightMetrics.baseBottomRightRadius).toBe('0px')
  expect(lightMetrics.greyMarginTop).toBe('0px')
  expect(lightMetrics.greyTopRightRadius).toBe('0px')
  expect(lightMetrics.preBg).toBe('rgb(244, 244, 246)')
  expect(lightMetrics.thBg).toBe('rgb(244, 244, 246)')

  // Switch to dark theme and confirm both baseline and hardcoded inline quote colors adapt cleanly.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '应用设置' })
  await dialog.getByRole('radio', { name: /深色/ }).click()
  await dialog.getByRole('button', { name: '完成', exact: true }).click()

  const darkMetrics = await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    const doc = iframe.contentDocument!
    const win = iframe.contentWindow as unknown as Record<string, unknown>
    const baseQuote = doc.defaultView!.getComputedStyle(doc.getElementById('base-quote')!)
    const greyQuote = doc.defaultView!.getComputedStyle(doc.getElementById('grey-quote')!)
    return {
      sameWindow: win.__previewSessionId === 'theme-stable',
      baseColor: baseQuote.color,
      baseBg: baseQuote.backgroundColor,
      greyColor: greyQuote.color,
      greyBg: greyQuote.backgroundColor,
    }
  })
  expect(darkMetrics.sameWindow).toBe(true)
  expect(darkMetrics.baseColor).toBe('rgb(180, 181, 199)')
  expect(darkMetrics.baseBg).toBe('rgb(34, 36, 48)')
  expect(darkMetrics.greyColor).toBe('rgb(180, 181, 199)')
  expect(darkMetrics.greyBg).toBe('rgb(34, 36, 48)')

  // Switch back to light theme and confirm original inline quote colors restore.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByRole('radio', { name: /浅色/ }).click()
  await dialog.getByRole('button', { name: '完成', exact: true }).click()

  const restoredLight = await frame.locator('#grey-quote').evaluate((el) => {
    const style = getComputedStyle(el)
    return { color: style.color, bg: style.backgroundColor }
  })
  expect(restoredLight.color).toBe('rgb(85, 85, 85)')
  expect(restoredLight.bg).toBe('rgb(245, 245, 245)')
})
