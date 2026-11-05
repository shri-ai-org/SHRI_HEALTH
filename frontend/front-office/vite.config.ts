import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

// ─── Care Entry = Front Office + Patient Self-Registration, ONE app ──────────
// The patient self-registration portal keeps its own source in the sibling
// `patient-self-registration/` workspace and is NOT copied here. It is served
// by THIS Vite server (and included in THIS build) under
//
//     /patient-self-registration
//
// How: `patient-self-registration/index.html` and `demo.html` in this folder are
// two extra HTML entry pages whose script points at the portal's own source
// (../../patient-self-registration/src). Vite therefore serves them from the
// same dev server — one process, one port, working hot reload — and bundles
// them into the same `dist/`. No proxy, no second server.
const PORTAL_ROUTE = '/patient-self-registration'

// `/patient-self-registration` (with or without a trailing slash) opens the
// portal's entry page instead of falling through to Front Office's router.
function portalRoute(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const [path, query] = (req.url ?? '').split('?')
    if (path === PORTAL_ROUTE || path === `${PORTAL_ROUTE}/`) {
      req.url = `${PORTAL_ROUTE}/index.html${query ? `?${query}` : ''}`
    }
    next()
  }
  return {
    name: 'care-entry-patient-self-registration-route',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  }
}

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

// https://vite.dev/config/
export default defineConfig({
  // Deployment sub-path, e.g. BASE_PATH=/dev/care-entry/ (defaults to the site root)
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss(), portalRoute()],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp(new Date())),
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  // Listen on all network interfaces so colleagues on the same LAN can open the app
  server: { host: true },
  preview: { host: true },
  build: {
    // Fonts are never inlined as data: URLs, so a strict CSP `font-src 'self'`
    // still works (DESIGN_SYSTEM §0).
    assetsInlineLimit: (filePath: string) => (/\.(woff2?|ttf|otf)$/.test(filePath) ? false : undefined),
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        patientSelfRegistration: resolve(import.meta.dirname, 'patient-self-registration/index.html'),
        patientSelfRegistrationDemo: resolve(import.meta.dirname, 'patient-self-registration/demo.html'),
      },
    },
  },
})
