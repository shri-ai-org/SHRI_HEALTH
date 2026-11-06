import { useCallback, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { notifications } from '../../data/notifications'
import type { NotificationTier } from '../../data/notifications'
import { cn } from '../../utils/cn'
import { useDismiss } from '../../hooks/useDismiss'

// GP-04 — notification bell, criticality-tiered (DESIGN_SYSTEM §8.7).
// Operational content only; nothing clinical ever appears here.
const TIER_DOT: Record<NotificationTier, string> = {
  critical: 'bg-critical-fg',
  urgent: 'bg-warning-fg',
  routine: 'bg-info-fg',
  digest: 'bg-ink-subtle',
}

const TIER_LABEL: Record<NotificationTier, string> = {
  critical: 'Critical',
  urgent: 'Urgent',
  routine: 'Routine',
  digest: 'Digest',
}

export function NotificationsMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, rootRef, triggerRef)
  const count = notifications.length

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Notifications (${count} unread)`}
        className="focus-ring tap-target relative rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Bell size={19} aria-hidden="true" />
        {count > 0 ? (
          <span className="absolute right-1.5 top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-2xs font-semibold leading-none tabular-nums text-on-danger">
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>

      {open ? (
        // Below `sm` the panel spans the window (it can sit anywhere in a
        // wrapped header); from `sm` it hangs off the bell.
        <div className="fixed inset-x-4 top-[calc(var(--app-header-h,4rem)+0.25rem)] z-40 overflow-hidden rounded-xl border border-border-soft bg-surface-1 shadow-card-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+6px)] sm:w-[calc(100vw-2rem)] sm:max-w-sm">
          <p className="border-b border-border-soft px-3.5 py-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Notifications</p>
          <ul className="max-h-96 overflow-y-auto overscroll-contain">
            {notifications.map((item) => (
              <li key={item.id} className="flex items-start gap-2.5 border-b border-border-soft bg-primary-50/40 px-3.5 py-3 last:border-b-0">
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', TIER_DOT[item.tier])} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="break-words text-sm text-ink">
                    <span className="sr-only">{TIER_LABEL[item.tier]}: </span>
                    {item.text}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-subtle">{item.time}</p>
                </div>
                <span className="ml-auto shrink-0 rounded-full bg-primary-100 px-1.5 py-0.5 text-2xs font-semibold text-primary-text">New</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
