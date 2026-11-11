import type { CSSProperties } from 'react'
import { cn } from '../../utils/cn'

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'

// Initials fallback (DESIGN_SYSTEM §10.7): a pastel circle with the
// initials in the hue's ink, the hue chosen by a hash of the FULL name — so
// two people who share initials still differ, and the same person is always
// the same colour on every page. Red is left out: it means "urgent" here.
const PALETTE = [
  'var(--color-hue-blue)',
  'var(--color-hue-teal)',
  'var(--color-hue-violet)',
  'var(--color-hue-pink)',
  'var(--color-hue-orange)',
  'var(--color-hue-green)',
  'var(--color-hue-indigo)',
  'var(--color-hue-cyan)',
]

const SIZES: Record<AvatarSize, string> = {
  xs: 'h-6 w-6 text-2xs',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-xl',
  '2xl': 'h-20 w-20 text-2xl',
  '3xl': 'h-24 w-24 text-3xl',
}

const HONORIFIC = /^(dr|prof|shri|smt|sri|mr|mrs|ms|miss|kumari)\.?$/i

/** "Dr. Asha Rao" → "Asha Rao"; honorifics never colour or label a person. */
function withoutHonorifics(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((part) => !HONORIFIC.test(part))
    .join(' ')
}

function hashIndex(value: string, length: number): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash % length
}

export function Avatar({
  initials,
  name,
  size = 'md',
  className = '',
}: {
  initials?: string
  /** The person's full name: picks the colour, and is the fallback label. */
  name?: string
  size?: AvatarSize
  className?: string
}) {
  const key = withoutHonorifics(name ?? '') || initials || '?'
  const hue = PALETTE[hashIndex(key.toLowerCase(), PALETTE.length)]

  return (
    <span
      aria-hidden="true"
      style={{ '--tone': hue } as CSSProperties}
      className={cn(
        'ink-tone inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold',
        'bg-[linear-gradient(145deg,color-mix(in_oklab,var(--tone)_26%,var(--color-surface-1)),color-mix(in_oklab,var(--tone)_12%,var(--color-surface-1)))]',
        'shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tone)_28%,transparent)]',
        SIZES[size],
        className,
      )}
    >
      {initials}
    </span>
  )
}
