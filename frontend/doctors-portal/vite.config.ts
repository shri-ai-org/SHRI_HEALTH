import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { realApiProxy, realApiSettings, sessionStub } from '../dev/realApi.ts'

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

// SHRI_HEALTH: `SHRI_API=real npm run dev` sends /api/v1 to the local stack, signed in as
// SHRI_DEV_USER through X-Dev-User (../dev/realApi.ts, #109).
const realApi = realApiSettings(process.env)

export default defineConfig({
  /**
   * Where the built app is mounted. The dev server and the harness run at `/`;
   * a hosted copy under a path (shri-ai.org/dev/clinician) is built with
   * `npm run build:dev` (PORTAL_BASE=/dev/clinician/). The router, the CT slice paths
   * and index.html all read this, so nothing else needs to know.
   */
  base: process.env.PORTAL_BASE ?? '/',
  plugins: [react(), tailwindcss(), ...(realApi?.stubSessions ? [sessionStub(realApi)] : [])],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp(new Date())),
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
    // SHRI_API=real: read the clinic's time zone before the first screen (shri-health/format.ts).
    __SHRI_REAL_API__: JSON.stringify(Boolean(realApi)),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // SHRI_HEALTH: the screens import react-router-dom 7; SHRI_HEALTH ships react-router 8.
      'react-router-dom': 'react-router',
      // SHRI_HEALTH: not installed (video visits are not in the demo); see shri-health/.
      'fix-webm-duration': fileURLToPath(new URL('./shri-health/fixWebmDurationStub.ts', import.meta.url)),
    },
  },
  server: {
    // 5173 is taken by another project on this machine; this one owns 5180.
    // `strictPort` makes a clash fail loudly rather than drift to 5174, which
    // would silently point every harness at the wrong app.
    port: 5180,
    strictPort: true,
    host: true,
    ...(realApi ? { proxy: { '/api/v1': realApiProxy(realApi) } } : {}),
  },
})
