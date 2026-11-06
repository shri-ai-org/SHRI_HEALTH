import { createContext, useContext } from 'react'
import type { ComponentPropsWithoutRef, CSSProperties, ElementType, ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { IconBadge } from './IconBadge'
import { TONE_VAR } from '../../utils/tone'
import type { Tone } from '../../utils/tone'

type CardEmphasis = 'default' | 'critical' | 'quiet'

/** A card's colour, so its header can pick up the same hue. */
const CardAccent = createContext<string | undefined>(undefined)

export function Card({
  className = '',
  emphasis = 'default',
  /** The card's colour (DESIGN_SYSTEM §4.4 — hue in soft tints, never a
   *  saturated fill): a faint wash of it on the header and its hue mixed
   *  into the edge. The body stays plain so lists and forms read cleanly;
   *  print drops the colour. */
  accentTone,
  children,
  style,
  ...props
}: ComponentPropsWithoutRef<'div'> & { emphasis?: CardEmphasis; accentTone?: Tone }) {
  const emphasisStyles: Record<CardEmphasis, string> = {
    default: 'surface-raised border border-border-soft bg-surface-1',
    critical: 'border border-critical-fg/30 bg-critical-bg',
    quiet: 'border border-border-soft bg-surface-2',
  }
  const accentVar = accentTone ? TONE_VAR[accentTone] : undefined
  const edge = accentVar ? `color-mix(in oklab, var(--color-${accentVar}) 24%, var(--color-border-soft))` : undefined

  return (
    <div
      className={cn(
        'min-w-0 rounded-xl',
        emphasisStyles[emphasis],
        // A soft gradient line of the hue along the top edge.
        accentVar &&
          'card-accent relative before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-[2px] before:rounded-full before:[background-image:linear-gradient(90deg,transparent,var(--tone)_25%,color-mix(in_oklab,var(--tone)_40%,transparent)_75%,transparent)] print:before:hidden',
        className,
      )}
      style={accentVar ? ({ borderColor: edge, '--tone': `var(--color-${accentVar})`, ...style } as CSSProperties) : style}
      {...props}
    >
      <CardAccent.Provider value={accentVar}>{children}</CardAccent.Provider>
    </div>
  )
}

export function CardHeader({
  icon: Icon,
  iconTone,
  title,
  subtitle,
  action,
  className = '',
}: {
  icon?: ElementType
  /** Semantic accent for the header icon — reuses the app's existing tone
   *  palette (see utils/tone.ts). Omitted keeps the previous neutral color. */
  iconTone?: Tone
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const accentVar = useContext(CardAccent)
  return (
    <div
      className={cn(
        'flex min-h-11 items-center justify-between gap-3 px-3.5 py-3 sm:gap-4 sm:px-4 lg:px-5',
        accentVar && 'card-accent-head rounded-t-[inherit] border-b border-border-soft',
        className,
      )}
      // A wash of the card's hue that fades out across the header.
      style={
        accentVar
          ? {
              backgroundImage: [
                `radial-gradient(90% 160% at 0% 0%, color-mix(in oklab, var(--color-${accentVar}) 13%, transparent) 0%, transparent 60%)`,
                `linear-gradient(100deg, color-mix(in oklab, var(--color-${accentVar}) 6%, transparent) 0%, transparent 75%)`,
              ].join(', '),
            }
          : undefined
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
        {Icon ? <IconBadge icon={Icon} tone={iconTone ?? 'neutral'} size="xs" variant={iconTone && iconTone !== 'neutral' ? 'solid' : 'soft'} /> : null}
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold tracking-[-0.01em] text-ink">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs leading-snug text-ink-subtle">{subtitle}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function CardBody({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-3.5 py-3.5 sm:px-4 lg:px-5', className)}>{children}</div>
}
