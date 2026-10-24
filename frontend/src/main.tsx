import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FrontDeskApp } from './app/FrontDeskApp'
import { ToastProvider } from './design-system'
import { createMockPortalApi } from './features/portal/api/mockPortalApi'
import { PortalApp } from './features/portal/PortalApp'
import { PORTAL_BASE } from './features/portal/router'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

// Display settings the patient chose on this device (Profile & settings → Display).
try {
  const html = document.documentElement
  if (localStorage.getItem('shri-theme') === 'dark') html.classList.add('dark')
  if (localStorage.getItem('shri-portal-large') === 'true') html.dataset.largeText = 'true'
  if (localStorage.getItem('shri-portal-contrast') === 'true') html.dataset.highContrast = 'true'
} catch {
  // Storage unavailable: defaults apply.
}

const isPortal = window.location.pathname === PORTAL_BASE || window.location.pathname.startsWith(`${PORTAL_BASE}/`)

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      {/* The portal runs on the mock API (synthetic data) until the /portal contract and backend exist. */}
      {isPortal ? <PortalApp api={createMockPortalApi()} /> : <FrontDeskApp />}
    </ToastProvider>
  </StrictMode>,
)
