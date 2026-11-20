import { defineConfig } from '@playwright/test'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173'
const WEB_PORT = Number(new URL(BASE_URL).port || 5173)

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
