import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FrontDeskApp } from './app/FrontDeskApp'
import { ToastProvider } from './design-system'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <FrontDeskApp />
    </ToastProvider>
  </StrictMode>,
)
