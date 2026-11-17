import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

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
  // A build without git (the deploy image) is given the day's version and commit by the deploy
  // kit: SHRI_BUILD_DAY_VERSION and SHRI_BUILD_COMMIT, worked out from the checkout it deploys.
  let count = Number(process.env.SHRI_BUILD_DAY_VERSION) || 0
  if (!count) try {
    count = Number(execSync(`git rev-list --count --since="${yyyy}-${mm}-${dd}T00:00:00+05:30" HEAD`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) || 0
  } catch {
    /* not a git checkout */
  }
  return `V_${dd} ${mm}-${String(Math.max(1, count)).padStart(2, '0')}`
}

function buildCommit(): string {
  if (process.env.SHRI_BUILD_COMMIT) return process.env.SHRI_BUILD_COMMIT.slice(0, 12)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

// SHRI_HEALTH: `SHRI_API=real npm run dev` sends /api/v1 to the local stack, signed in as
// SHRI_DEV_USER through X-Dev-User (../dev/realApi.ts, #109).
const realApi = realApiSettings(process.env)

// A production build talks to the real API unless SHRI_API=mock asks for the sample data (a
// mock-up site), so a missing setting can never put sample data on a real server. The dev server
// keeps its own switch (SHRI_API=real).
const realApiBuild = process.env.SHRI_API !== 'mock'

// SHRI_HEALTH: the sample screens' imported scans (src/data/imaging.generated.ts, ncct.generated.ts)
// list real, de-identified patients' studies and share-alike or non-commercial images, against D12
// and D75. With the real API, both resolve to the empty stand-ins in shri-health/, the same way
// fix-webm-duration is stubbed below, so a real-API build carries none of it (scripts/check-bundle.mjs
// proves it). A hook rather than an alias, because src/data imports them by relative path too.
const FENCED = {
  'imaging.generated': fileURLToPath(new URL('./shri-health/imagingGeneratedStub.ts', import.meta.url)),
  'ncct.generated': fileURLToPath(new URL('./shri-health/ncctGeneratedStub.ts', import.meta.url)),
}
function fenceImportedScans(): Plugin {
  return {
    name: 'shri-fence-imported-scans',
    enforce: 'pre',
    resolveId(source) {
      const m = /(?:^|\/)(imaging|ncct)\.generated(?:\.ts)?$/.exec(source)
      return m ? FENCED[`${m[1] as 'imaging' | 'ncct'}.generated`] : null
    },
  }
}

export default defineConfig(({ command }) => ({
  /**
   * Where the built app is mounted. The dev server and the harness run at `/`;
   * a hosted copy under a path (shri-ai.org/dev/clinician) is built with
   * `npm run build:dev` (PORTAL_BASE=/dev/clinician/). The router, the CT slice paths
   * and index.html all read this, so nothing else needs to know.
   */
  base: process.env.PORTAL_BASE ?? '/',
  plugins: [
    react(),
    tailwindcss(),
    ...(realApi?.stubSessions ? [sessionStub(realApi)] : []),
    ...(realApi || (command === 'build' && realApiBuild) ? [fenceImportedScans()] : []),
  ],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp(new Date())),
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
    // SHRI_API=real: read the clinic's time zone before the first screen (shri-health/format.ts).
    __SHRI_REAL_API__: JSON.stringify(Boolean(realApi) || (command === 'build' && realApiBuild)),
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
}))
