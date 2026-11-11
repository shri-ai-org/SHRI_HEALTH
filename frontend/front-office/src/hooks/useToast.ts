import { createContext, useContext } from 'react'

export type ToastTone = 'success' | 'error' | 'info'

export interface NotifyOptions {
  tone?: ToastTone
  detail?: string
}

export interface ToastContextValue {
  notify: (message: string, options?: NotifyOptions) => number
  dismiss: (id: number) => void
}

// Context object + hook live here (no components) so the provider file can
// export only a component — keeps fast-refresh happy.
export const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within a ToastProvider')
  return context
}
