import type { CSSProperties } from 'react'
import { Bell } from 'lucide-react'
import { cn } from '../../utils/cn'
import type { NavBadge } from '../../domain/selectors'

const HUE: Record<NavBadge['tone'], string> = {
  critical: 'var(--color-hue-red)',
  warning: 'var(--color-hue-amber)',
  info: 'var(--color-hue-blue)',
}

/**
 * A count beside a place in the navigation. Urgent counts are a solid chip
 * (red); the rest a soft pill in their hue. `dot` is the collapsed rail's
 * form. The count is also said in words for screen readers.
 */
export function NavCount({ badge, dot = false, className }: { badge: NavBadge; dot?: boolean; className?: string }) {
  const style = { '--tone': HUE[badge.tone] } as CSSProperties
  if (dot) {
    return (
      <span
        style={style}
        className={cn('chip-solid pointer-events-none absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-surface-1', className)}
        aria-hidden="true"
      >
        <Bell size={9} strokeWidth={2.5} />
      </span>
    )
  }
  return (
    <span
      style={style}
      title={badge.label}
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded-full px-1.5 text-2xs font-bold tabular-nums',
        badge.tone === 'critical' ? 'chip-solid' : 'ink-tone bg-[color-mix(in_oklab,var(--tone)_16%,var(--color-surface-1))]',
        className,
      )}
    >
      <Bell size={10} strokeWidth={2.5} aria-hidden="true" />
      {badge.count > 99 ? '99+' : badge.count}
    </span>
  )
}
