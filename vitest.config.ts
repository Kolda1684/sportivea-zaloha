import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Build-time constants that electron.vite.config.ts injects into the main bundle only.
  define: {
    __GOOGLE_OAUTH_CLIENT_ID__: JSON.stringify(''),
    __GOOGLE_OAUTH_CLIENT_SECRET__: JSON.stringify(''),
  },
  test: {
    environment: 'node',
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
