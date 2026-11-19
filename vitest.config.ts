import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // apps/server has its own config: its tests need an embedded Postgres globalSetup.
    include: ['packages/**/test/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
  },
})
