import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn'

type ToastTone = 'success' | 'info' | 'critical'

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const TONE: Record<ToastTone, string> = {
  success: 'border-success-fg/30 bg-success-bg text-success-fg',
  info: 'border-info-fg/30 bg-info-bg text-info-fg',
  critical: 'border-critical-fg/30 bg-critical-bg text-critical-fg',
}

/**
 * Short confirmations ("Appointment booked"). Announced politely and never takes focus. Toasts are
 * not for errors the user must act on: use Alert or ProblemAlert for those.
 */
export function ToastProvider({ children, durationMs = 5000 }: { children: ReactNode; durationMs?: number }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const show = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = nextId.current++
      setItems((list) => [...list, { id, tone, message }])
      window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), durationMs)
    },
    [durationMs],
  )
  const api = useMemo(() => ({ show }), [show])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={cn('pointer-events-auto rounded-lg border px-3.5 py-2.5 text-sm shadow-card-lg', TONE[t.tone])}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside <ToastProvider>')
  return api
}
