/**
 * The patient portal's production entry (`npm run build:portal`, `vite.portal.config.ts`), served
 * at `/portal/` (deploy: `frontend/dist-portal/`, every unknown path falling back to
 * `/portal/portal.html`). `src/main.tsx` keeps the portal out of the staff build.
 *
 * The B8a screens use the real API (`/api/v1/portal/...`, the patient realm's sign-in); the later
 * screens still run on the in-memory mock with synthetic data until B8b (D88, D89), as in
 * development. Patients only: the session is the portal's own (ADR-0013).
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from './design-system'
import MockPortal from './features/portal/MockPortal'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

try {
  if (localStorage.getItem('shri-theme') === 'dark') document.documentElement.classList.add('dark')
} catch {
  // Storage unavailable: the light theme applies.
}

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <MockPortal />
    </ToastProvider>
  </StrictMode>,
)
