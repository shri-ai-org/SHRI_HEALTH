import type { CSSProperties, ElementType } from 'react'
import { cn } from '../../utils/cn'
import { TONE_HEX } from '../../utils/toneHex'
import type { IconTone } from '../../utils/toneHex'

type TileSize = 'sm' | 'md' | 'lg'

const SOFT_BOX: Record<TileSize, string> = {
  sm: 'h-7 w-7 rounded-[8px]',
  md: 'h-9 w-9 rounded-[10px]',
  lg: 'h-11 w-11 rounded-xl',
}
const SOFT_GLYPH: Record<TileSize, number> = { sm: 15, md: 18, lg: 20 }

/**
 * The quiet tile (DESIGN_SYSTEM §12.1): 12% of the destination hue (18% in
 * dark), the glyph a shade darker in light and the pure hue in dark. For
 * dashboard headings, "Go to" tiles, figure cards and inline pills.
 */
export function SoftIconTile({
  icon: Icon,
  tone,
  size = 'md',
  className,
}: {
  icon: ElementType
  tone: IconTone
  size?: TileSize
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      style={{ '--tone': TONE_HEX[tone] } as CSSProperties}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        'bg-[color-mix(in_oklab,var(--tone)_12%,transparent)] text-[color-mix(in_oklab,var(--tone)_72%,black)]',
        'dark:bg-[color-mix(in_oklab,var(--tone)_18%,transparent)] dark:text-[var(--tone)]',
        SOFT_BOX[size],
        className,
      )}
    >
      <Icon size={SOFT_GLYPH[size]} strokeWidth={2} />
    </span>
  )
}

const SOLID_BOX: Record<TileSize, string> = {
  sm: 'h-7 w-7 rounded-[8px]',
  md: 'h-9 w-9 rounded-[10px]',
  lg: 'h-12 w-12 rounded-[14px]',
}
const SOLID_GLYPH: Record<TileSize, number> = { sm: 15, md: 18, lg: 24 }

/** The solid tile (§12.1) — white glyph on the hue. For the nav drawer,
 *  the More sheet and the collapsed rail only. */
export function IconTile({
  icon: Icon,
  tone,
  size = 'md',
  className,
}: {
  icon: ElementType
  tone: IconTone
  size?: TileSize
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: TONE_HEX[tone] }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)]',
        SOLID_BOX[size],
        className,
      )}
    >
      <Icon size={SOLID_GLYPH[size]} strokeWidth={2.2} />
    </span>
  )
}
