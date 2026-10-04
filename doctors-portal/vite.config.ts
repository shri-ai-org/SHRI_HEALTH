import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// ─── Build stamp ─────────────────────────────────────────────────────────────
// Shown at the foot of the sidebar so anyone can tell which build they are
// looking at: "OCT 3 - 12:05 @26" (India time, when this build was made),
// with the commit it was built from in its tooltip.
function buildStamp(at: Date): string {
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', ...options }).format(at)
  const time = part({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${part({ month: 'short' }).toUpperCase()} ${part({ day: 'numeric' })} - ${time} @${part({ year: '2-digit' })}`
}

function buildCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  /**
   * Where the built app is mounted. The dev server and the harness run at `/`;
   * a hosted copy under a path (shri-ai.org/dev/clinician) is built with
   * `npm run build:dev` (PORTAL_BASE=/dev/clinician/). The router, the CT slice paths
   * and index.html all read this, so nothing else needs to know.
   */
  base: process.env.PORTAL_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp(new Date())),
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
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
