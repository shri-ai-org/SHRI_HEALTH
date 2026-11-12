import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import './index.css'
import App from './App.tsx'
import { SessionProvider } from '../../src/api/session'
import { FrontOfficeLanding } from '../../src/api/landing'
import { ErrorBoundary } from './components/ErrorBoundary'
import { REAL_API } from '../shri-health/client'
import { loadClinic } from '../shri-health/scheduling'

// Last-resort logging for errors outside React's render (event handlers,
// timers, promises), so nothing fails silently in production.
window.addEventListener('error', (event) => console.error('[window]', event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => console.error('[promise]', event.reason))

// SHRI_API=real: the clinic's time zone comes first, so the first screen already shows its today.
// If the server can't be reached the app opens anyway, and each page says what it could not read.
const ready = REAL_API ? loadClinic().catch((err: unknown) => console.error('[clinic]', err)) : Promise.resolve()

void ready.then(() => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Honours the OS "reduce motion" setting for every framer-motion animation. */}
    <MotionConfig reducedMotion="user">
      <ErrorBoundary scope="root">
        <SessionProvider>
          {/* MD, APP and RN land in the doctors' portal, before the front office renders. */}
          <FrontOfficeLanding>
            <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <App />
            </BrowserRouter>
          </FrontOfficeLanding>
        </SessionProvider>
      </ErrorBoundary>
    </MotionConfig>
  </StrictMode>,
))
