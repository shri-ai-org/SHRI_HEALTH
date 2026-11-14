import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { ProxyOptions } from 'vite'
import { defineConfig } from 'vitest/config'
import { realApiProxy, realApiSettings, sessionStub } from './dev/realApi.ts'

// Development only: `npm run dev` sends /api/v1 to the contract mock (contracts/: `npm run mock`;
// MOCK_GUIDE §1–§3). Calls stay same-origin, as in production, so cookies and CSRF behave the
// same. Prism serves paths without /api/v1 and only checks that a session cookie is present, so
// the proxy strips the prefix and adds the mock's placeholder cookie: the portal one on /portal
// paths, the staff one elsewhere (MOCK_GUIDE §5d). Set SHRI_MOCK_URL to use another port.
// `SHRI_API=real npm run dev` uses the local stack through Nginx instead (dev/realApi.ts).
const mockUrl = process.env.SHRI_MOCK_URL ?? 'http://127.0.0.1:4010'
const realApi = realApiSettings(process.env)

const mockProxy: ProxyOptions = {
  target: mockUrl,
  changeOrigin: true,
  rewrite: (path) => path.replace(/^\/api\/v1/, '') || '/',
  configure: (proxy) => {
    proxy.on('proxyReq', (req) => {
      if (req.getHeader('cookie')) return
      // Enrollment is public: it is sent with no cookie, as in production.
      if (req.path.startsWith('/portal/enrollments')) return
      req.setHeader('Cookie', req.path.startsWith('/portal') ? '__Host-shri_portal=mock' : '__Host-shri_session=mock')
    })
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(realApi?.stubSessions ? [sessionStub(realApi)] : [])],
  // `SHRI_API=real npm run dev`: the portal hides its sample-data screens, as its production build
  // does (features.ts, M4); with the contract mock (and in unit tests) they stay.
  define: { __SHRI_REAL_API__: JSON.stringify(Boolean(realApi)) },
  server: {
    proxy: {
      '/api/v1': realApi ? realApiProxy(realApi) : mockProxy,
    },
  },
  build: {
    // Fonts stay files, so a strict CSP `font-src 'self'` works (infra/nginx/nginx.conf).
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/.test(filePath) ? false : undefined),
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup.ts'],
          // The copied apps (front-office/, patient-self-registration/) have no tests here; the
          // doctors' portal has its own project below.
          include: ['src/**/*.test.{ts,tsx}', 'dev/**/*.test.ts'],
          css: false,
        },
      },
      {
        // The doctors' portal's own unit tests, with its `@` (doctors-portal/src) and the real-API build flag.
        root: './doctors-portal',
        resolve: { alias: { '@': fileURLToPath(new URL('./doctors-portal/src', import.meta.url)) } },
        define: { __SHRI_REAL_API__: 'true' },
        test: {
          name: 'doctors-portal',
          environment: 'jsdom',
          include: ['shri-health/**/*.test.ts', 'src/shri/logic/**/*.test.ts'],
          css: false,
        },
      },
    ],
  },
})
