import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const BASE = 'http://127.0.0.1:5173'
const OUT = new URL('../shots/', import.meta.url).pathname
const EMAIL = 'e2e@booksmith.local'
const PASSWORD = 'e2e-password-2026'
const FIXTURE = fileURLToPath(new URL('../fixtures/马克思经济学与数理分析.epub', import.meta.url))

mkdirSync(OUT, { recursive: true })

const API = 'http://127.0.0.1:8787'

async function clearLibrary() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!login.ok) return
  const cookie = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0]
  const books = await (await fetch(`${API}/api/books`, { headers: { cookie } })).json()
  for (const book of books.books) {
    await fetch(`${API}/api/books/${book.id}`, { method: 'DELETE', headers: { cookie } })
  }
}

await clearLibrary()

const issues = []
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
// A 401 on /auth/login is the deliberate wrong-password probe below, not a defect.
const EXPECTED = [/\/api\/auth\/login$/, /\/api\/auth\/me$/]
page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`))
page.on('response', (response) => {
  if (response.status() < 400) return
  if (EXPECTED.some((pattern) => pattern.test(new URL(response.url()).pathname))) return
  issues.push(`http ${response.status()} ${new URL(response.url()).pathname}`)
})

const overflow = async (label) => {
  const delta = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  if (delta > 0) issues.push(`overflow(${label}): ${delta}px`)
  return delta
}
const brokenImages = async (label) => {
  const broken = await page.evaluate(
    () => Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).length,
  )
  if (broken > 0) issues.push(`broken-images(${label}): ${broken}`)
}

await page.goto(BASE)
await page.waitForSelector('text=登录')
await page.screenshot({ path: `${OUT}/login-1440.png` })
await overflow('login-1440')

await page.getByLabel('邮箱').fill(EMAIL)
await page.getByLabel('密码').fill('wrong-password')
await page.getByRole('button', { name: '登录' }).click()
await page.waitForSelector('[role=alert]')
await page.screenshot({ path: `${OUT}/login-error-1440.png` })

await page.getByLabel('密码').fill(PASSWORD)
await page.getByRole('button', { name: '登录' }).click()
await page.waitForSelector('text=书库还是空的')
await page.screenshot({ path: `${OUT}/library-empty-1440.png` })
await overflow('library-empty-1440')

await page.setInputFiles('[data-testid=upload-input]', FIXTURE)
await page.waitForSelector('text=马克思经济学与数理分析')
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/library-1440.png` })
await overflow('library-1440')
await brokenImages('library-1440')

await page.setViewportSize({ width: 400, height: 860 })
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/library-400.png`, fullPage: true })
await overflow('library-400')

await page.setViewportSize({ width: 1440, height: 900 })
await page.getByPlaceholder('搜索书名或作者').fill('没有这本书')
await page.waitForSelector('text=没有匹配')
await page.screenshot({ path: `${OUT}/search-empty-1440.png` })
await overflow('search-empty-1440')

await page.getByRole('button', { name: '清空搜索' }).click()
await page.waitForTimeout(200)
await page.getByRole('button', { name: /马克思经济学与数理分析/ }).first().click()
await page.waitForURL(/\/books\//)
await page.waitForSelector('.cm-content')
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/editor-1440.png` })
await overflow('editor-1440')

await page.getByRole('button', { name: 'ch010.xhtml', exact: true }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/editor-ch010-1440.png` })

await page.getByRole('tab', { name: '元数据' }).click()
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/editor-metadata-1440.png` })

await page.getByRole('tab', { name: '目录' }).click()
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/editor-toc-1440.png` })

await page.getByRole('tab', { name: '查找' }).click()
await page.getByLabel('全书查找').fill('置盐定理')
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/editor-search-1440.png` })

await page.getByRole('tab', { name: '版本' }).click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/editor-versions-1440.png` })
await page.getByRole('tab', { name: '预览' }).click()

await page.setViewportSize({ width: 400, height: 860 })
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/editor-400.png` })
await overflow('editor-400')

await page.getByRole('button', { name: '文件' }).click()
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/editor-400-drawer.png` })
await overflow('editor-400-drawer')

await page.setViewportSize({ width: 1440, height: 900 })
await page.emulateMedia({ colorScheme: 'dark' })
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/editor-dark-1440.png` })
await overflow('editor-dark-1440')

await page.emulateMedia({ colorScheme: 'light' })
await page.getByRole('button', { name: '← 书库' }).click()
await page.getByRole('button', { name: '新建书' }).click()
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/library-new-book-1440.png` })

await browser.close()

console.log(issues.length === 0 ? 'audit: clean' : `audit: ${issues.length} issue(s)`)
for (const issue of issues) console.log(` - ${issue}`)
process.exit(issues.length === 0 ? 0 : 1)
