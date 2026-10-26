import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { FrontDeskApp } from './app/FrontDeskApp'
import { ToastProvider } from './design-system'
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

// The patient portal runs on the mock API (synthetic data) until the /portal contract exists (B8,
// D88), so only development builds serve it. In a production build this is null and the portal
// code is left out of the bundle.
const MockPortal = import.meta.env.DEV ? lazy(() => import('./features/portal/MockPortal')) : null

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
