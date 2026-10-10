import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// ─── Build stamp ─────────────────────────────────────────────────────────────
// Shown at the foot of the sidebar so anyone can tell which version they are
// looking at: "V_10 10-01" — V_, the day and month (India time), then which
// version of that day it is: the count of the day's commits up to the one built,
// so rebuilding the same commit keeps its number. The commit is in its tooltip.
function buildStamp(at: Date): string {
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', ...options }).format(at)
  const dd = part({ day: '2-digit' })
  const mm = part({ month: '2-digit' })
  const yyyy = part({ year: 'numeric' })
  let count = 0
  try {
    count = Number(execSync(`git rev-list --count --since="${yyyy}-${mm}-${dd}T00:00:00+05:30" HEAD`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) || 0
  } catch {
    /* not a git checkout */
  }
  return `V_${dd} ${mm}-${String(Math.max(1, count)).padStart(2, '0')}`
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
