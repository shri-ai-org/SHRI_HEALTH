// Must come first: in DEV it writes the harness flags into localStorage before
// any persisted store reads them, and exposes the `window.__*` hooks the
// verify scripts use. See the note in src/e2e.ts; none of it reaches `dist`.
import '../e2e'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import ShriApp from './ShriApp'
import './theme/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ShriApp />
    </BrowserRouter>
  </StrictMode>,
)
