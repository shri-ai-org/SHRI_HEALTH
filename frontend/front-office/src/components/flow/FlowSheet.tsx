import { useId, useRef } from 'react'
import type { ElementType, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { IconBadge } from '../ui/IconBadge'
import { LiveClock } from '../layout/LiveClock'
import { useLayer } from '../../hooks/useLayer'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useScrollLock } from '../../hooks/useScrollLock'
import type { Tone } from '../../utils/tone'
import { cn } from '../../utils/cn'

/**
 * The surface every flow (schedule, reschedule, billing, admit, discharge) runs
 * in: a full-height panel over the right of the current page, so the page
 * the desk started from stays where it is underneath and is back the moment
 * the flow closes. Escape and the close button both close it; clicking the
 * dimmed page does not, so a half-finished flow is never lost by a stray click.
 */
export function FlowSheet({
  title,
  subtitle,
  icon,
  iconTone = 'brand',
  onClose,
  children,
  footer,
  size = 'panel',
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ElementType
  iconTone?: Tone
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** 'panel' — the usual side panel; 'full' — the whole screen, for a flow that lays
   *  every choice out at once (Schedule Appointment). */
  size?: 'panel' | 'full'
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useLayer(true, onClose)
  useFocusTrap(panel, true)
  useScrollLock(true)

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end print:hidden">
      <motion.div
        className="absolute inset-0 bg-scrim"
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
      />
      <motion.div
        ref={panel}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'relative flex h-full w-full flex-col border-l border-border-soft bg-surface-1 shadow-card-lg focus:outline-none',
          size === 'full' ? 'max-w-none' : 'max-w-2xl',
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-soft px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5 sm:pb-4 sm:pt-4">
          <div className="flex min-w-0 items-center gap-3">
            {icon ? <IconBadge icon={icon} tone={iconTone} size="sm" /> : null}
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-base font-semibold tracking-tight text-ink">
                {title}
              </h2>
              {subtitle ? <div className="mt-0.5 truncate text-xs text-ink-muted">{subtitle}</div> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
          <LiveClock />
          <button
            type="button"
            onClick={onClose}
            data-skip-autofocus
            className="focus-ring tap-target -mr-2 shrink-0 rounded-lg text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Close"
          >
            <X size={20} aria-hidden="true" />
          </button>
          </div>
        </header>
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', size === 'full' ? 'px-4 py-4 sm:px-6' : 'px-4 py-5 sm:px-5')}>{children}</div>
        {footer ? (
          <footer className={cn('safe-bottom shrink-0 border-t border-border-soft pt-3 [--safe-bottom-base:0.75rem] sm:pt-4 sm:[--safe-bottom-base:1rem]', size === 'full' ? 'px-4 sm:px-6' : 'px-4 sm:px-5')}>{footer}</footer>
        ) : null}
      </motion.div>
    </div>,
    document.body,
  )
}
