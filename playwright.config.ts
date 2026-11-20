import { defineConfig } from '@playwright/test'

const DEFAULT_PORT = Number(process.env.E2E_WEB_PORT ?? 5173)
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`
const WEB_PORT = Number(new URL(BASE_URL).port || DEFAULT_PORT)

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `pnpm --filter @booksmith/web dev --port ${WEB_PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 90_000,
  },
})
