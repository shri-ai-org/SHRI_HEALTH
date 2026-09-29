import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  /**
   * Where the built app is mounted. The dev server and the harness run at `/`;
   * a hosted copy under a path (shri-ai.org/dev/doctor) is built with
   * `PORTAL_BASE=/dev/doctor/ npm run build`. The router, the CT slice paths
   * and index.html all read this, so nothing else needs to know.
   */
  base: process.env.PORTAL_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 5173 is taken by another project on this machine; this one owns 5180.
    // `strictPort` makes a clash fail loudly rather than drift to 5174, which
    // would silently point every harness at the wrong app.
    port: 5180,
    strictPort: true,
    host: true,
  },
})
