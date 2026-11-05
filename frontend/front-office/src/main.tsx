import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'

// Last-resort logging for errors outside React's render (event handlers,
// timers, promises), so nothing fails silently in production.
window.addEventListener('error', (event) => console.error('[window]', event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => console.error('[promise]', event.reason))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Honours the OS "reduce motion" setting for every framer-motion animation. */}
    <MotionConfig reducedMotion="user">
      <ErrorBoundary scope="root">
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </MotionConfig>
  </StrictMode>,
)
