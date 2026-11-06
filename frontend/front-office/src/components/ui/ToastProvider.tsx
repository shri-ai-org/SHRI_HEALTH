import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { ToastContext } from '../../hooks/useToast'
import type { NotifyOptions, ToastTone } from '../../hooks/useToast'
import { cn } from '../../utils/cn'

interface Toast {
  id: number
  message: string
  detail?: string
  tone: ToastTone
}

const AUTO_DISMISS_MS = 5000
const ICONS = { success: CheckCircle2, error: AlertTriangle, info: Info }
const STYLES: Record<ToastTone, string> = {
  success: 'border-success-fg/30 bg-success-bg text-success-fg',
  error: 'border-critical-fg/30 bg-critical-bg text-critical-fg',
  info: 'border-info-fg/30 bg-info-bg text-info-fg',
}

/**
 * Confirmation toasts (DESIGN_SYSTEM §10.8): a polite live region that never
 * takes focus, bottom-right, clear of the home indicator, and above every overlay (z-60).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) window.clearTimeout(timer)
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (message: string, { tone = 'success', detail }: NotifyOptions = {}) => {
      const id = ++idRef.current
      setToasts((current) => [...current, { id, message, detail, tone }])
      timers.current.set(id, window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS))
      return id
    },
    [dismiss],
  )

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => window.clearTimeout(timer))
  }, [])

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          role="status"
          aria-live="polite"
          className="toast-region safe-inset-b pointer-events-none fixed right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 [--safe-inset-base:1rem] md:right-6 md:[--safe-inset-base:1.5rem] print:hidden"
        >
          <AnimatePresence initial={false}>
            {toasts.map((toast) => {
              const Icon = ICONS[toast.tone] ?? Info
              return (
                <motion.div
                  key={toast.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className={cn('pointer-events-auto flex items-start gap-2.5 rounded-lg border py-2.5 pl-3.5 pr-1 shadow-card-lg', STYLES[toast.tone] ?? STYLES.info)}
                >
                  <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1 break-words">
                    <p className="text-sm font-semibold">{toast.message}</p>
                    {toast.detail ? <p className="mt-0.5 text-xs text-ink-muted">{toast.detail}</p> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => dismiss(toast.id)}
                    className="focus-ring -my-2 tap-target shrink-0 rounded-lg opacity-70 transition-opacity hover:opacity-100"
                    aria-label="Dismiss notification"
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}
