import type { ElementType, ReactNode } from 'react'
import { Info, AlertTriangle, ShieldCheck } from 'lucide-react'
import { TONE_STYLES } from '../../utils/tone'
import type { Tone } from '../../utils/tone'
import { cn } from '../../utils/cn'

const ICONS: Partial<Record<Tone, ElementType>> = {
  info: Info,
  warning: AlertTriangle,
  critical: AlertTriangle,
  stable: ShieldCheck,
}

/**
 * The banner (DESIGN_SYSTEM §10.10): a tone pair, a 16px icon, readable text.
 * Critical banners announce assertively; the rest politely, and only when
 * `live` is set (a static note on page load need not be announced).
 */
export function Alert({
  tone = 'info',
  icon,
  title,
  live = false,
  children,
  className = '',
}: {
  tone?: Tone
  icon?: ElementType
  title?: ReactNode
  /** Announce this banner when it appears (for messages that arrive later). */
  live?: boolean
  children?: ReactNode
  className?: string
}) {
  const styles = TONE_STYLES[tone] ?? TONE_STYLES.info
  const Icon = icon ?? ICONS[tone] ?? Info
  const politeness = tone === 'critical' ? 'assertive' : 'polite'

  return (
    <div
      role={live && tone === 'critical' ? 'alert' : undefined}
      aria-live={live ? politeness : undefined}
      className={cn('flex items-start gap-2.5 rounded-lg border px-3.5 py-3', styles.bg, styles.border, className)}
    >
      <Icon size={16} className={cn('mt-0.5 shrink-0', styles.text)} aria-hidden="true" />
      <div className="min-w-0 text-sm leading-relaxed text-ink-muted [&_strong]:font-semibold [&_strong]:text-ink">
        {title ? <p className={cn('font-semibold', styles.text)}>{title}</p> : null}
        {children}
      </div>
    </div>
  )
}
