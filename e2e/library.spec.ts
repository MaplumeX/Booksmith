import { expect, test } from '@playwright/test'
import { BOOK_TITLE, FIXTURE, E2E_PASSWORD, expectLoggedIn, login, resetLibrary } from './helpers'

test.beforeAll(async () => {
  await resetLibrary()
})

test('shows an inline error for a wrong password', async ({ page }) => {
  await login(page, 'definitely-wrong-password')
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不对')
  // Still on the login screen, nothing was navigated.
  await expect(page.getByLabel('邮箱')).toBeVisible()
})

test('opens an empty library and imports a book', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)
  await expect(page.getByText('书库还是空的')).toBeVisible()

  await page.setInputFiles('[data-testid=upload-input]', FIXTURE)

  await expect(page.getByText(BOOK_TITLE)).toBeVisible()
  await expect(page.getByText(/^28 章 ·/)).toBeVisible()
  await expect(page.getByText('1 本')).toBeVisible()
})

test('opens the editor route from a book card', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)

  if (await page.getByText('书库还是空的').isVisible()) {
    await page.setInputFiles('[data-testid=upload-input]', FIXTURE)
  }

  await page.getByRole('button', { name: new RegExp(BOOK_TITLE) }).click()
  await expect(page).toHaveURL(/\/books\/[0-9a-f-]{36}$/)
})

test('shows a search empty state and can clear it', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)

  await page.getByPlaceholder('搜索书名或作者').fill('没有这本书')
  await expect(page.getByText(/没有匹配/)).toBeVisible()

  await page.getByRole('button', { name: '清空搜索' }).click()
  await expect(page.getByPlaceholder('搜索书名或作者')).toHaveValue('')
})

test('logs out back to the login screen', async ({ page }) => {
  await login(page)
  await expectLoggedIn(page)
  await page.getByRole('button', { name: '退出' }).click()
  await expect(page.getByLabel('邮箱')).toBeVisible()
})
