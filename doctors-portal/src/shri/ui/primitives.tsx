/**
 * The small parts every card is made of. Sizes and radii are the spec's
 * (§3.3, §3.4); tones come from `.sh-tone-*` so a pill never names a colour.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import type { LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'
import type { ConfidenceBand, Tone } from '../mocks/types'
import { useAiActive } from '../state/ai'

/* ---------------------------------------------------------------- Icon */

export interface IconProps {
  icon: LucideIcon
  size?: number
  strokeWidth?: number
  className?: string
}
/** lucide at the spec's stroke width 1.8 unless told otherwise. */
export function Icon({ icon: I, size = 18, strokeWidth = 1.8, className }: IconProps) {
  return <I size={size} strokeWidth={strokeWidth} className={cn('shrink-0', className)} aria-hidden="true" />
}

/* ---------------------------------------------------------------- Card */

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode
  /** 19/500 on My Day, 17/500 on the record (§3.3). */
  titleSize?: 'md' | 'sm'
  /** Slot to the right of the title. */
  right?: ReactNode
  headerClassName?: string
  as?: 'section' | 'div' | 'article'
}
export function Card({ title, titleSize = 'md', right, headerClassName, className, children, as = 'section', ...rest }: CardProps) {
  const Tag = as
  return (
    <Tag className={cn('flex min-h-0 flex-col rounded-sh-card bg-sh-card p-[18px] text-sh-text', className)} {...rest}>
      {(title || right) && (
        <header className={cn('mb-[14px] flex min-h-[34px] items-center gap-[10px]', headerClassName)}>
          {title && (
            <h2 className={cn('font-medium tracking-[-0.012em] text-sh-text', titleSize === 'md' ? 'text-[19px]/[1.2]' : 'text-[17px]/[1.2]')}>
              {title}
            </h2>
          )}
          {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
        </header>
      )}
      {children}
    </Tag>
  )
}

/* ---------------------------------------------------------------- Pill */

const pill = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-[7px] whitespace-nowrap rounded-full font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
  {
    variants: {
      variant: {
        primary: 'bg-sh-primary text-sh-on-primary hover:bg-sh-primary-hover',
        control: 'bg-sh-control text-sh-text hover:bg-sh-hover-strong',
        card: 'bg-sh-card text-sh-text hover:bg-sh-hover',
        accent: 'bg-sh-accent text-sh-accent-ink hover:brightness-95',
        inner: 'bg-sh-inner text-sh-text hover:bg-sh-hover-strong',
        tone: 'bg-(--t-bg) text-(--t-fg)',
        ghost: 'bg-transparent text-sh-text-2 hover:bg-sh-hover',
        outline: 'bg-transparent text-sh-text border border-sh-line-strong hover:bg-sh-hover',
        crit: 'bg-sh-crit-solid text-sh-on-crit-solid hover:brightness-95',
      },
      size: {
        xs: 'h-[22px] px-[8px] text-[11px]',
        sm: 'h-[28px] px-[10px] text-[12px]',
        md: 'h-[34px] px-[14px] text-[13px]',
        lg: 'h-[40px] px-[16px] text-[13px]',
        xl: 'h-[46px] px-[18px] text-[14px]',
        bar: 'h-[48px] px-[16px] text-[14px]',
      },
    },
    defaultVariants: { variant: 'control', size: 'md' },
  },
)

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof pill> {
  tone?: Tone
  icon?: LucideIcon
  iconSize?: number
}
export function Pill({ variant, size, tone, icon, iconSize = 15, className, children, type = 'button', ...rest }: PillProps) {
  return (
    <button type={type} className={cn(tone && `sh-tone-${tone}`, pill({ variant: tone ? 'tone' : variant, size }), className)} {...rest}>
      {icon && <Icon icon={icon} size={iconSize} strokeWidth={2} />}
      {children}
    </button>
  )
}

/** The same shape as a non-interactive `<span>` — status words, counts. */
export interface PillTagProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pill> {
  tone?: Tone
  icon?: LucideIcon
  iconSize?: number
}
export function PillTag({ variant, size, tone, icon, iconSize = 13, className, children, ...rest }: PillTagProps) {
  return (
    <span className={cn(tone && `sh-tone-${tone}`, pill({ variant: tone ? 'tone' : variant, size }), className)} {...rest}>
      {icon && <Icon icon={icon} size={iconSize} strokeWidth={2.2} />}
      {children}
    </span>
  )
}

/* ---------------------------------------------------------------- Chip */

/** §5.4 timeline chips: bold number + short word, coloured by tone. */
export function Chip({ num, word, tone = 'neu', className }: { num?: string; word?: string; tone?: Tone; className?: string }) {
  return (
    <span
      className={cn(
        `sh-tone-${tone}`,
        'inline-flex h-[22px] items-center gap-[4px] rounded-full bg-(--t-bg) px-[8px] text-[12px]/none text-(--t-fg)',
        className,
      )}
    >
      {num && <b className="font-semibold">{num}</b>}
      {word && <span className="font-medium">{word}</span>}
    </span>
  )
}

/** A status: icon + one short word, never colour alone (§1.3). */
export function StatusPill({ icon, word, tone, className, size = 'sm' }: { icon: LucideIcon; word: string; tone: Tone; className?: string; size?: 'xs' | 'sm' }) {
  return (
    <PillTag tone={tone} size={size} icon={icon} className={cn('font-medium', className)} title={word}>
      {word}
    </PillTag>
  )
}

/** Count bubble inside a tab or a KPI chip. */
export function CountBubble({ children, active, className }: { children: ReactNode; active?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-[6px] text-[11px] font-semibold tabular-nums',
        active ? 'bg-sh-accent text-sh-accent-ink' : 'bg-sh-card text-sh-text',
        className,
      )}
    >
      {children}
    </span>
  )
}

/* --------------------------------------------------------- RoundButton */

const roundButton = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        control: 'bg-sh-control text-sh-text hover:bg-sh-hover-strong',
        card: 'bg-sh-card text-sh-text hover:bg-sh-hover',
        primary: 'bg-sh-primary text-sh-on-primary hover:bg-sh-primary-hover',
        accent: 'bg-sh-accent text-sh-accent-ink hover:brightness-95',
        ghost: 'bg-transparent text-sh-text-2 hover:bg-sh-hover',
        outline: 'bg-transparent text-sh-text border-[1.5px] border-current hover:bg-sh-hover',
        inner: 'bg-sh-inner text-sh-text hover:bg-sh-hover-strong',
      },
      size: {
        30: 'size-[30px]',
        34: 'size-[34px]',
        36: 'size-[36px]',
        38: 'size-[38px]',
        40: 'size-[40px]',
        44: 'size-[44px]',
        48: 'size-[48px]',
        56: 'size-[56px]',
      },
    },
    defaultVariants: { variant: 'control', size: 40 },
  },
)

export interface RoundButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof roundButton> {
  icon: LucideIcon
  iconSize?: number
  strokeWidth?: number
  /** Required — every icon-only button is named (§12). Doubles as the tooltip. */
  label: string
}
export function RoundButton({ icon, iconSize = 18, strokeWidth = 1.8, label, variant, size, className, type = 'button', ...rest }: RoundButtonProps) {
  return (
    <button type={type} aria-label={label} title={label} className={cn(roundButton({ variant, size }), className)} {...rest}>
      <Icon icon={icon} size={iconSize} strokeWidth={strokeWidth} />
    </button>
  )
}

/* --------------------------------------------------------- Confidence */

/** §8 / §4.5 — always written; the mark is 10px. A percentage may accompany the band's words, never replace them. */
export function ConfidenceMark({ band, short, score, className }: { band: ConfidenceBand; short?: boolean; score?: number; className?: string }) {
  if (!band) return <span className={cn('text-[12px] text-sh-text-2', className)}>Cannot assess</span>
  const label = band === 'HIGH' ? 'High confidence' : band === 'MED' ? 'Moderate confidence' : 'Low confidence — review closely'
  return (
    <span className={cn('inline-flex items-center gap-[6px] text-[12px] text-sh-text-2', className)} title={label}>
      <span
        aria-hidden="true"
        className={cn(
          'inline-block size-[10px] rounded-full border-[1.5px] border-sh-pend-fg',
          band === 'HIGH' && 'bg-sh-pend-fg',
          band === 'MED' && 'bg-[linear-gradient(90deg,var(--pend-fg)_50%,transparent_50%)]',
        )}
      />
      {short ? label.split(' ')[0] : label}
      {score !== undefined && <span className="tabular-nums text-sh-text-3">· {Math.round(score * 100)}%</span>}
    </span>
  )
}

/* -------------------------------------------------------------- Diamond */

/** ◆ marks AI (§1.5). Renders nothing while the AI fabric is off. */
export function Diamond({ className, title = 'AI-generated' }: { className?: string; title?: string }) {
  const aiOn = useAiActive()
  if (!aiOn) return null
  return (
    <span className={cn('inline-block text-[10px]/none text-sh-ai', className)} aria-label={title} title={title} role="img">
      ◆
    </span>
  )
}

/* --------------------------------------------------------------- Toggle */

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[24px] w-[44px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-sh-accent' : 'bg-sh-line-strong',
        className,
      )}
    >
      <span className={cn('sh-knob block size-[20px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]', checked ? 'ml-[20px]' : 'ml-0')} />
    </button>
  )
}

/* --------------------------------------------------------------- Avatar */

const avatar = cva('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold uppercase tracking-[0.02em]', {
  variants: {
    variant: {
      accent: 'bg-sh-accent text-sh-accent-ink hover:brightness-95',
      pend: 'bg-sh-pend-bg text-sh-pend-fg',
      primary: 'bg-sh-primary text-sh-on-primary',
      inner: 'bg-sh-inner text-sh-text',
    },
    size: {
      32: 'size-[32px] text-[12px]',
      36: 'size-[36px] text-[13px]',
      40: 'size-[40px] text-[14px]',
      48: 'size-[48px] text-[16px]',
      52: 'size-[52px] text-[18px]',
      56: 'size-[56px] text-[19px]',
    },
  },
  defaultVariants: { variant: 'inner', size: 36 },
})
export function Avatar({ initials, variant, size, className }: { initials: string; className?: string } & VariantProps<typeof avatar>) {
  return (
    <span className={cn(avatar({ variant, size }), className)} aria-hidden="true">
      {initials}
    </span>
  )
}

/* -------------------------------------------------------- SectionLabel */

/** 11/600 uppercase, 0.08em — only for ATTENTION / TASKS / CHANGED SINCE THEN (§3.3). */
export function SectionLabel({ children, count, right, className }: { children: ReactNode; count?: number; right?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-[24px] items-center gap-[8px]', className)}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{children}</span>
      {count !== undefined && (
        <span className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-sh-control px-[6px] text-[11px] font-semibold tabular-nums text-sh-text">
          {count}
        </span>
      )}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  )
}

/* ------------------------------------------------------------ Skeleton */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-[10px] bg-sh-inner', className)} aria-hidden="true" />
}

/* ------------------------------------------------------------- Hairline */

export function Hairline({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div className={cn(vertical ? 'w-px self-stretch bg-sh-line' : 'h-px w-full bg-sh-line', className)} aria-hidden="true" />
}

/** A tiny tone dot for menus and chips. */
export function ToneDot({ tone, size = 8, className }: { tone: Tone; size?: number; className?: string }) {
  return <span aria-hidden="true" className={cn(`sh-tone-${tone}`, 'inline-block shrink-0 rounded-full bg-(--t)', className)} style={{ width: size, height: size }} />
}
