import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'electron-vite'
import type { Plugin } from 'vite'

const CSP_PRODUCTION = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'"
// Dev only: React Refresh injects an inline preamble script and HMR uses a websocket.
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:*"

function contentSecurityPolicy(): Plugin {
  return {
    name: 'zaloha-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        const content = ctx.server ? CSP_DEV : CSP_PRODUCTION
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }]
      },
    },
  }
}

export default defineConfig(({ mode, command }) => {
  // Empty prefix = read every variable of .env; only the two OAuth values are injected, and only into main.
  const env = loadEnv(mode, process.cwd(), '')
  const clientId = env['GOOGLE_OAUTH_CLIENT_ID'] ?? ''
  const clientSecret = env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? ''
  // A build (including `npm run app`) must never ship empty OAuth values; dev stays lenient.
  if ((command === 'build' || mode === 'production') && (clientId === '' || clientSecret === '')) {
    const missing = [clientId === '' ? 'GOOGLE_OAUTH_CLIENT_ID' : '', clientSecret === '' ? 'GOOGLE_OAUTH_CLIENT_SECRET' : ''].filter(Boolean)
    throw new Error(`Missing in .env: ${missing.join(', ')}. Set them before building.`)
  }
  return {
    main: {
      define: {
        __GOOGLE_OAUTH_CLIENT_ID__: JSON.stringify(clientId),
        __GOOGLE_OAUTH_CLIENT_SECRET__: JSON.stringify(clientSecret),
      },
    },
    preload: {
      build: {
        // Sandboxed preload scripts must be CommonJS (package.json is "type": "module").
        rolldownOptions: {
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      plugins: [react(), contentSecurityPolicy()],
    },
  }
})
