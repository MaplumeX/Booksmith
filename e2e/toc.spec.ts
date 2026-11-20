import { expect, test, type Page } from '@playwright/test'
import { expectLoggedIn, login, seedBook } from './helpers'

let bookId: string

test.beforeEach(async () => {
  bookId = await seedBook()
})

async function openToc(page: Page) {
  await login(page)
  await expectLoggedIn(page)
  await page.goto(`/books/${bookId}`)
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('tab', { name: '目录' }).click()
  await expect(page.locator('.toc-item').first()).toBeVisible()
}

async function openRowMenu(page: Page, rowLocator: ReturnType<Page['locator']>) {
  await rowLocator.hover()
  await rowLocator.locator('.toc-more-btn').click()
}

test('clicks a toc entry to jump to chapter and highlights it', async ({ page }) => {
  await openToc(page)

  // Click a nested chapter item and verify the active tab switches and item highlights.
  const target = page.locator('.toc-item').nth(2)
  await target.locator('.toc-label').click()
  await expect(target).toHaveClass(/is-active/)
  await expect(page.locator('.tab.on')).toBeVisible()
})

test('adds a toc entry via link dialog with anchor picker and keeps it after reload', async ({ page }) => {
  await openToc(page)
  const before = await page.locator('.toc-item').count()

  await page.getByRole('button', { name: '新增', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('目标文件').fill('text/ch003.xhtml')
  await expect(dialog.getByLabel('标题')).not.toHaveValue('')
  await dialog.getByRole('button', { name: '添加' }).click()

  await expect(page.locator('.toc-item')).toHaveCount(before + 1)
  await expect(page.locator('.toc-item').last().locator('.toc-label')).not.toBeEmpty()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('tab', { name: '目录' }).click()
  await expect(page.locator('.toc-item')).toHaveCount(before + 1)
})

test('indents, order-preserving outdents, and supports undo/redo via row menu', async ({ page }) => {
  await openToc(page)

  // First entry cannot indent or outdent.
  await openRowMenu(page, page.locator('.toc-item').first())
  await expect(page.getByRole('menuitem', { name: /^缩进为上一项子项/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('menuitem', { name: /^取消缩进升一级/ })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  // Add a temporary entry at the end, indent it, outdent it, then undo/redo.
  await page.getByRole('button', { name: '新增', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('目标文件').fill('text/ch003.xhtml')
  await dialog.getByLabel('标题').fill('临时目录项')
  await dialog.getByRole('button', { name: '添加' }).click()

  const added = page.locator('.toc-item').filter({ hasText: '临时目录项' })
  const beforeDepth = Number(await added.getAttribute('data-toc-depth'))

  await openRowMenu(page, added)
  await page.getByRole('menuitem', { name: /缩进为上一项子项/ }).click()
  await expect(page.locator('.toc-item').filter({ hasText: '临时目录项' })).toHaveAttribute(
    'data-toc-depth',
    String(beforeDepth + 1),
  )

  await openRowMenu(page, page.locator('.toc-item').filter({ hasText: '临时目录项' }))
  await page.getByRole('menuitem', { name: /取消缩进升一级/ }).click()
  await expect(page.locator('.toc-item').filter({ hasText: '临时目录项' })).toHaveAttribute(
    'data-toc-depth',
    String(beforeDepth),
  )

  // Undo brings it back to indented depth; redo restores outdented depth.
  await page.getByRole('button', { name: '撤销目录操作' }).click()
  await expect(page.locator('.toc-item').filter({ hasText: '临时目录项' })).toHaveAttribute(
    'data-toc-depth',
    String(beforeDepth + 1),
  )
  await page.getByRole('button', { name: '重做目录操作' }).click()
  await expect(page.locator('.toc-item').filter({ hasText: '临时目录项' })).toHaveAttribute(
    'data-toc-depth',
    String(beforeDepth),
  )
})

test('collapses by depth, filters by keyword, and fixes a broken anchor in-place', async ({ page }) => {
  await openToc(page)
  const total = await page.locator('.toc-item').count()
  expect(total).toBeGreaterThan(20)

  // Collapse to level 1 via more menu.
  await page.getByRole('button', { name: '更多目录操作' }).click()
  await page.getByRole('menuitem', { name: '仅展开 1 级' }).click()
  const level1Count = await page.locator('.toc-item').count()
  expect(level1Count).toBeLessThan(total)

  // Expand all back.
  await page.getByRole('button', { name: '更多目录操作' }).click()
  await page.getByRole('menuitem', { name: '全部展开' }).click()
  await expect(page.locator('.toc-item')).toHaveCount(total)

  // Add an entry with a broken anchor, then fix it via the broken pill -> TocLinkDialog.
  await page.getByRole('button', { name: '新增', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('目标文件').fill('text/ch003.xhtml#nonexistent-anchor')
  await dialog.getByLabel('标题').fill('断链测试项')
  await dialog.getByRole('button', { name: '添加' }).click()

  await page.getByLabel('筛选目录').fill('断链测试项')
  await expect(page.locator('.toc-item')).toHaveCount(1)
  const brokenRow = page.locator('.toc-item').first()
  await expect(brokenRow.locator('.toc-warn-pill')).toBeVisible()

  await brokenRow.locator('.toc-warn-pill').click()
  dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('锚点 ID').fill('')
  await dialog.getByRole('button', { name: '保存修改' }).click()

  await expect(page.locator('.toc-item').first().locator('.toc-warn-pill')).toHaveCount(0)
})

test('supports multi-select batch indent and keep-children delete', async ({ page }) => {
  await openToc(page)

  // Add two fresh top-level entries at the end so we have a clean test pair.
  for (const title of ['批量甲', '批量乙']) {
    await page.getByRole('button', { name: '新增', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('目标文件').fill('text/ch003.xhtml')
    await dialog.getByLabel('标题').fill(title)
    await dialog.getByRole('button', { name: '添加' }).click()
  }

  // Enter multi-select mode and select both.
  await page.getByRole('button', { name: '更多目录操作' }).click()
  await page.getByRole('menuitem', { name: '多选批量调级' }).click()

  await page.locator('.toc-item').filter({ hasText: '批量甲' }).locator('.toc-select-box').check()
  await page.locator('.toc-item').filter({ hasText: '批量乙' }).locator('.toc-select-box').check()
  await expect(page.getByText('已选 2 项')).toBeVisible()

  await page.getByRole('button', { name: '批量缩进' }).click()
  await expect(page.locator('.toc-item').filter({ hasText: '批量甲' })).toHaveAttribute('data-toc-depth', '1')
  await expect(page.locator('.toc-item').filter({ hasText: '批量乙' })).toHaveAttribute('data-toc-depth', '1')

  // Exit multi-select, indent 批量乙 under 批量甲, then delete 批量甲 keeping children.
  await openRowMenu(page, page.locator('.toc-item').filter({ hasText: '批量乙' }))
  await page.getByRole('menuitem', { name: /缩进为上一项子项/ }).click()
  await expect(page.locator('.toc-item').filter({ hasText: '批量乙' })).toHaveAttribute('data-toc-depth', '2')

  await openRowMenu(page, page.locator('.toc-item').filter({ hasText: '批量甲' }))
  await page.getByRole('menuitem', { name: /仅删除此项/ }).click()
  await expect(page.locator('.toc-item').filter({ hasText: '批量甲' })).toHaveCount(0)
  await expect(page.locator('.toc-item').filter({ hasText: '批量乙' })).toHaveAttribute('data-toc-depth', '1')
})

test('generates TOC from headings with custom level selection and persists after reload', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await openToc(page)
  await page.getByRole('button', { name: '生成', exact: true }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('从正文标题生成目录')).toBeVisible()

  // Switch to rebuild mode and keep only H1 + H2.
  await dialog.getByRole('button', { name: '重建目录' }).click()
  await dialog.getByRole('button', { name: 'H3', exact: true }).click()

  const previewCount = await dialog.locator('.toc-gen-item').count()
  expect(previewCount).toBeGreaterThan(0)

  await dialog.getByRole('button', { name: '应用生成结果' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.toc-item')).toHaveCount(previewCount)

  // Save and reload to verify persistence.
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.appbar-meta')).toHaveText('v2')

  await page.reload()
  await expect(page.getByLabel('书籍文件')).toBeVisible()
  await page.getByRole('tab', { name: '目录' }).click()
  await expect(page.locator('.toc-item')).toHaveCount(previewCount)
  expect(consoleErrors).toEqual([])
})

test('renders TocPanel and dialogs cleanly without horizontal overflow in light and dark themes', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await openToc(page)
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    const sidebarOverflow = await page.locator('.toc-panel').evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(sidebarOverflow).toBe(false)

    await page.getByRole('button', { name: '生成', exact: true }).click()
    const genDialog = page.getByRole('dialog')
    await expect(genDialog).toBeVisible()
    const dialogOverflow = await genDialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(dialogOverflow).toBe(false)
    await page.keyboard.press('Escape')
  }

  expect(consoleErrors).toEqual([])
})
