import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { FrontDeskApp } from './app/FrontDeskApp'
import { ToastProvider } from './design-system'
import { PORTAL_ENABLED } from './features/portal/features'
import { PORTAL_BASE } from './features/portal/router'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

// The theme chosen in the design-system preview on this device.
try {
  if (localStorage.getItem('shri-theme') === 'dark') document.documentElement.classList.add('dark')
} catch {
  // Storage unavailable: the light theme applies.
}

// The patient portal's B8a screens use the generated client, but its later screens still run on
// the in-memory mock (synthetic data) until B8b (D88, D89), and core doesn't serve the portal yet,
// so only development builds serve it (PORTAL_ENABLED). In a production build this is null and
// the portal code is left out of the bundle: `import.meta.env.DEV` is checked here as well because
// the bundler only drops the lazy chunk for a condition it can see in this file. It goes, with
// MockPortal, when the portal ships.
const MockPortal = import.meta.env.DEV && PORTAL_ENABLED ? lazy(() => import('./features/portal/MockPortal')) : null

const isPortal = window.location.pathname === PORTAL_BASE || window.location.pathname.startsWith(`${PORTAL_BASE}/`)

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      {MockPortal && isPortal ? (
        <Suspense fallback={null}>
          <MockPortal />
        </Suspense>
      ) : (
        <FrontDeskApp />
      )}
    </ToastProvider>
  </StrictMode>,
)
