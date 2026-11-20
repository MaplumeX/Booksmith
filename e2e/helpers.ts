import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const API = process.env.E2E_API ?? process.env.BOOKSMITH_API ?? 'http://127.0.0.1:8787'
export const E2E_EMAIL = 'e2e@booksmith.local'
export const E2E_PASSWORD = 'e2e-password-2026'
export const FIXTURE = fileURLToPath(new URL('../fixtures/马克思经济学与数理分析.epub', import.meta.url))
export const BOOK_TITLE = '马克思经济学与数理分析'

/** Ensures the e2e account exists and owns no books. Requires the dev API on :8787. */
export async function resetLibrary(): Promise<void> {
  const context = await playwrightRequest.newContext({ baseURL: API })
  await context.post('/api/auth/register', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  const login = await context.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  if (!login.ok()) throw new Error(`e2e login failed: ${login.status()} ${await login.text()}`)

  const list = (await (await context.get('/api/books')).json()) as { books: Array<{ id: string }> }
  for (const book of list.books) await context.delete(`/api/books/${book.id}`)
  await context.dispose()
}

export async function seedBook(): Promise<string> {
  await resetLibrary()
  const context = await playwrightRequest.newContext({ baseURL: API })
  const login = await context.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  if (!login.ok()) throw new Error(`seed login failed: ${login.status()}`)
  const upload = await context.post('/api/books', {
    headers: { 'content-type': 'application/epub+zip' },
    data: readFileSync(FIXTURE),
  })
  if (!upload.ok()) throw new Error(`seed upload failed: ${upload.status()} ${await upload.text()}`)
  const body = (await upload.json()) as { book: { id: string } }
  await context.dispose()
  return body.book.id
}

export async function login(page: Page, password = E2E_PASSWORD): Promise<void> {
  await page.goto('/')
  await page.getByLabel('邮箱').fill(E2E_EMAIL)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录' }).click()
}

export async function expectLoggedIn(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: '导入 EPUB' })).toBeVisible()
}
