import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DesignSystemPreview } from './app/DesignSystemPreview'
import { ToastProvider } from './design-system'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <DesignSystemPreview />
    </ToastProvider>
  </StrictMode>,
)
