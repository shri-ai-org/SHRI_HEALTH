import { useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '../../utils/cn'
import { useLayer } from '../../hooks/useLayer'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useScrollLock } from '../../hooks/useScrollLock'

const EASE = [0.16, 1, 0.3, 1] as const

/**
 * The modal (DESIGN_SYSTEM §10.8): portalled to <body>, focus trap, scroll
 * lock and focus restore; Esc closes only the top-most layer. Below 640px it
 * rises from the bottom edge as a sheet (thumb-reachable, clear of the home
 * indicator); from 640px it is a centred dialog.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className = '',
}: {
  open: boolean
  onClose?: () => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** Extra panel classes — e.g. `max-w-lg` for a wider dialog. */
  className?: string
}) {
  return createPortal(
    <AnimatePresence>
      {open ? (
        <ModalDialog key="modal" onClose={onClose} title={title} description={description} footer={footer} className={className}>
          {children}
        </ModalDialog>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

function ModalDialog({
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  onClose?: () => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className: string
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useLayer(true, onClose)
  useFocusTrap(dialog, true)
  useScrollLock(true)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4 print:hidden">
      <motion.div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-scrim backdrop-blur-[4px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 12 }}
        transition={{ duration: 0.25, ease: EASE }}
        className={cn(
          'relative z-10 flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden border border-border-soft bg-surface-1 shadow-modal focus:outline-none',
          'rounded-t-2xl sm:rounded-xl',
          className,
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold leading-snug tracking-tight text-ink">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              data-skip-autofocus
              className="focus-ring tap-target -mr-2 -mt-2 shrink-0 rounded-lg text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="Close dialog"
            >
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">{children}</div>
        {footer ? (
          <div className="safe-bottom flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border-soft px-5 pt-4 [--safe-bottom-base:1.25rem] sm:px-6 sm:[--safe-bottom-base:1.5rem]">
            {footer}
          </div>
        ) : null}
      </motion.div>
    </div>
  )
}
