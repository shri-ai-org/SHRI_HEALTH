import type { CSSProperties, ElementType } from 'react'
import { cn } from '../../utils/cn'
import { TONE_VAR } from '../../utils/tone'
import type { Tone } from '../../utils/tone'

// Design-system SoftIconTile sizes: 28px / 36px / 48px squircles.
const CONTAINER_SIZE: Record<'xs' | 'sm' | 'md', string> = {
  xs: 'h-7 w-7 rounded-[8px]',
  sm: 'h-9 w-9 rounded-[10px]',
  md: 'h-12 w-12 rounded-[14px]',
}

const ICON_SIZE: Record<'xs' | 'sm' | 'md', number> = {
  xs: 15,
  sm: 18,
  md: 24,
}

/** The shared "colored icon" treatment: a quiet, soft-tinted tile (12% of the
 *  hue in light theme, 18% in dark) holding a glyph in the hue itself. Hue
 *  goes in tints, not solid fills (design system §4.4) — reuses the app's
 *  tone tokens (see utils/tone.ts) via `color-mix()`, so it re-themes with
 *  light/dark for free. Purely a visual container. */
export function IconBadge({
  icon: Icon,
  tone = 'brand',
  size = 'md',
  /** Adds a very subtle scale-up when an ancestor with the Tailwind `group`
   *  class is hovered — for the dashboard tiles that are themselves clickable. */
  interactive = false,
  /** `solid`: a gradient chip in the hue with a white glyph — for headings
   *  that should carry colour. `soft` (default): a quiet tint. */
  variant = 'soft',
  className = '',
}: {
  icon: ElementType
  tone?: Tone
  size?: 'xs' | 'sm' | 'md'
  interactive?: boolean
  variant?: 'soft' | 'solid'
  className?: string
}) {
  const varName = TONE_VAR[tone] ?? 'ink-subtle'
  const style: CSSProperties = {
    ['--tone' as string]: `var(--color-${varName})`,
  }

  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        variant === 'solid'
          ? 'chip-solid'
          : 'ink-tone bg-[color-mix(in_oklab,var(--tone)_14%,transparent)] [[data-theme=dark]_&]:bg-[color-mix(in_oklab,var(--tone)_20%,transparent)]',
        CONTAINER_SIZE[size],
        interactive && 'transition-transform duration-150 group-hover:scale-105',
        className,
      )}
    >
      <Icon size={ICON_SIZE[size]} strokeWidth={2} />
    </span>
  )
}
