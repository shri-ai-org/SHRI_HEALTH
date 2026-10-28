import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Development only: `npm run dev` sends /api/v1 to the contract mock (contracts/: `npm run mock`;
// MOCK_GUIDE §1–§3). Calls stay same-origin, as in production, so cookies and CSRF behave the
// same. Prism serves paths without /api/v1 and only checks that a session cookie is present, so
// the proxy strips the prefix and adds the mock's placeholder cookie: the portal one on /portal
// paths, the staff one elsewhere (MOCK_GUIDE §5d). Set SHRI_MOCK_URL to use another port. The real
// local stack is reached through Nginx (https://localhost:8443) instead.
const mockUrl = process.env.SHRI_MOCK_URL ?? 'http://127.0.0.1:4010'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api/v1': {
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
      },
    },
  },
  build: {
    // Fonts stay files, so a strict CSP `font-src 'self'` works (infra/nginx/nginx.conf).
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/.test(filePath) ? false : undefined),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
