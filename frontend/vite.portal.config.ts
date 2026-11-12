// The patient portal's production build (`npm run build:portal`): `portal.html` and
// `src/portalMain.tsx` into `dist-portal/`, for `/portal/`. Deploy: serve `frontend/dist-portal/`
// at `/portal/`, with every path that isn't a file falling back to `/portal/portal.html`.
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/portal/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist-portal',
    emptyOutDir: true,
    rollupOptions: { input: 'portal.html' },
    // Fonts are never inlined, so a strict CSP `font-src 'self'` still works (as vite.config.ts).
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/.test(filePath) ? false : undefined),
  },
})
