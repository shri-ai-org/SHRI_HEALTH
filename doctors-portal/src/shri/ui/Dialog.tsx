/**
 * A modal in this build's look that owns its whole life: its own scrim, the
 * frame (`useModalFrame`: centred ≥ 768px, a near-full sheet below), a focus
 * trap, Esc, and the header with the ✕. For screens that raise a dialog from
 * local state — sign-in's "Reset your password", confirmations — rather than
 * through the shell's store.
 *
 * `dismissible={false}` is for the dialogs the old build forbids closing
 * (S-09-06, a critical result): no ✕, and Esc and the scrim do nothing.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { X, type LucideIcon } from 'lucide-react'
import { useEffect, useId, type ReactNode } from 'react'

import { cn } from '../lib/cn'

import { useModalFrame } from './frames'
import { useFocusTrap } from './hooks'
import { Icon, RoundButton } from './primitives'
import { Scrim } from './Scrim'

type DialogTone = 'default' | 'crit' | 'warn'

const BADGE: Record<DialogTone, string> = {
  default: 'bg-sh-accent text-sh-accent-ink',
  crit: 'bg-sh-crit-bg text-sh-crit-fg',
  warn: 'bg-sh-warn-bg text-sh-warn-fg',
}

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  icon?: LucideIcon
  tone?: DialogTone
  dismissible?: boolean
  width?: number
  /** `alertdialog` for a dialog that asks for a decision about something critical. */
  role?: 'dialog' | 'alertdialog'
  /**
   * Opens with focus on the title rather than the first control — for a long
   * dialog whose reason must be read before any choice (WAI-ARIA's advice for
   * an alertdialog taller than the screen). Tab then reaches the controls.
   */
  focusTitle?: boolean
  footer?: ReactNode
  children: ReactNode
}

export function Dialog(props: DialogProps) {
  return <AnimatePresence>{props.open && <DialogBody key="dialog" {...props} />}</AnimatePresence>
}

function DialogBody({
  onClose,
  title,
  subtitle,
  icon,
  tone = 'default',
  dismissible = true,
  width = 480,
  role = 'dialog',
  focusTitle = false,
  footer,
  children,
}: DialogProps) {
  const ref = useFocusTrap<HTMLDivElement>(true)
  const frame = useModalFrame(width)
  const titleId = useId()

  // While it is open this dialog owns Esc: nothing underneath closes instead.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (dismissible) onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [dismissible, onClose])

  return (
    <>
      <Scrim onClick={dismissible ? onClose : undefined} className="z-55" />
      <div className={cn(frame.outer, 'z-60')} style={frame.outerStyle}>
        <motion.div
          ref={ref}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          variants={frame.variants}
          initial="hidden"
          animate="shown"
          exit="exit"
          className={cn('rounded-sh-modal bg-sh-card p-[22px] text-sh-text shadow-sh-modal', frame.inner)}
        >
          <header className="flex items-center gap-[12px]">
            {icon && (
              <span className={cn('inline-flex size-[44px] shrink-0 items-center justify-center rounded-full', BADGE[tone])} aria-hidden="true">
                <Icon icon={icon} size={20} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2
                id={titleId}
                tabIndex={focusTitle ? -1 : undefined}
                data-autofocus={focusTitle ? 'true' : undefined}
                className="text-[19px]/[1.2] font-medium tracking-[-0.012em] text-sh-text focus:outline-none"
              >
                {title}
              </h2>
              {subtitle && <div className="mt-[2px] text-[12px] text-sh-text-3">{subtitle}</div>}
            </div>
            {dismissible && <RoundButton icon={X} label="Close" size={38} onClick={onClose} />}
          </header>
          <div className="mt-[16px] text-[14px]/[1.5] text-sh-text-2">{children}</div>
          {footer && <footer className="mt-[22px] flex flex-wrap items-center justify-end gap-[10px]">{footer}</footer>}
        </motion.div>
      </div>
    </>
  )
}
