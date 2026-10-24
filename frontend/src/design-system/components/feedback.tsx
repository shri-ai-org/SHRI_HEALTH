import { AlertTriangle, CircleCheck, Info, OctagonAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export type AlertTone = 'info' | 'warning' | 'critical' | 'success'

const TONE_CLASS: Record<AlertTone, string> = {
  info: 'bg-info-bg text-info-fg border-info-fg/30',
  warning: 'bg-warning-bg text-warning-fg border-warning-fg/30',
  critical: 'bg-critical-bg text-critical-fg border-critical-fg/30',
  success: 'bg-success-bg text-success-fg border-success-fg/30',
}

const TONE_ICON: Record<AlertTone, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  critical: OctagonAlert,
  success: CircleCheck,
}

/** Words that lead the alert, so severity is never told by colour alone (WCAG 1.4.1). */
const TONE_LABEL: Record<AlertTone, string> = {
  info: 'Note',
  warning: 'Warning',
  critical: 'Critical',
  success: 'Done',
}

export interface AlertProps {
  tone: AlertTone
  title: string
  children?: ReactNode
  /** Buttons such as "Override with reason". */
  actions?: ReactNode
  /**
   * Announce immediately (`role="alert"`). Use for errors that block the user and for critical
   * clinical alerts; other alerts are announced politely.
   */
  assertive?: boolean
}

/**
 * Banner with three clinical levels (info, warning, critical) plus success. Medication safety alerts
 * use this; a critical alert never blocks the clinician by itself (guide 04 Step 3).
 */
export function Alert({ tone, title, children, actions, assertive = tone === 'critical' }: AlertProps) {
  const Icon = TONE_ICON[tone]
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-lg border px-3.5 py-3', TONE_CLASS[tone])}
    >
      <Icon aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        <p className="font-semibold">
          <span className="sr-only">{TONE_LABEL[tone]}: </span>
          {title}
        </p>
        {children ? <div className="mt-0.5">{children}</div> : null}
        {actions ? <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

export type BadgeTone = AlertTone | 'neutral' | 'primary'

const BADGE_CLASS: Record<BadgeTone, string> = {
  ...TONE_CLASS,
  neutral: 'bg-surface-2 text-ink-muted border-border-soft',
  primary: 'bg-primary-50 text-primary-700 border-primary-200',
}

/** Status chip. Always has words; colour only reinforces them. */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold whitespace-nowrap', BADGE_CLASS[tone])}>
      {children}
    </span>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-ink-muted">
      <span aria-hidden="true" className="inline-block size-5 animate-spin rounded-full border-2 border-border-soft border-t-primary-600" />
      <span>{label}…</span>
    </span>
  )
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      {description ? <p className="mt-1.5 max-w-sm text-sm text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export interface ErrorStateProps {
  title: string
  description?: string
  /** `requestId` from the Problem, so support can find the server log. */
  reference?: string | undefined
  onRetry?: () => void
}

/** A failed panel: message, Retry and the reference id. One failed panel never blanks the page. */
export function ErrorState({ title, description, reference, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span aria-hidden="true" className="mb-3 flex size-12 items-center justify-center rounded-full bg-critical-bg text-critical-fg">
        <AlertTriangle size={22} />
      </span>
      <p className="text-base font-semibold text-ink">{title}</p>
      {description ? <p className="mt-1.5 max-w-sm text-sm text-ink-muted">{description}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex min-h-11 items-center rounded-lg border border-border bg-surface-1 px-4 text-sm font-semibold text-ink-muted hover:bg-surface-2"
        >
          Try again
        </button>
      ) : null}
      {reference ? <p className="mt-3 text-xs text-ink-subtle">Reference: {reference}</p> : null}
    </div>
  )
}
