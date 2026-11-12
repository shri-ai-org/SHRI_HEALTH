// Must come first: in DEV it writes the harness flags into localStorage before
// any persisted store reads them, and exposes the `window.__*` hooks the
// verify scripts use. See the note in src/e2e.ts; none of it reaches `dist`.
import '../e2e'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { SessionProvider } from '../../../src/api/session'
import { loadClinic } from '../../shri-health/opd'
import ShriApp from './ShriApp'
import './theme/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// SHRI_API=real: the clinic's time zone first, so the first screen already shows the clinic's time
// (D40). If the server can't be reached the app opens anyway, in the browser's time.
const ready = typeof __SHRI_REAL_API__ !== 'undefined' && __SHRI_REAL_API__ ? loadClinic().catch((err: unknown) => console.error('[clinic]', err)) : Promise.resolve()

void ready.then(() => createRoot(root).render(
  <StrictMode>
    <SessionProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <ShriApp />
      </BrowserRouter>
    </SessionProvider>
  </StrictMode>,
))
