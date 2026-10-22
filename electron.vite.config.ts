import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const CSP_PRODUCTION = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
// Dev only: React Refresh injects an inline preamble script and HMR uses a websocket.
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:*"

function contentSecurityPolicy(): Plugin {
  return {
    name: 'trideni-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        const content = ctx.server ? CSP_DEV : CSP_PRODUCTION
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }]
      },
    },
  }
}

export default defineConfig({
  main: {},
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
})
