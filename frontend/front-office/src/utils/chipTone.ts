import type { CSSProperties } from 'react'
import { TONE_HEX } from './toneHex'
import type { IconTone } from './toneHex'
import { cn } from './cn'

/**
 * The time-chip look shared by Doctor's Availability's hour blocks and the
 * booking slot board, so a time reads the same everywhere: a soft tint of a
 * hue with its edge and ink in the same hue (DESIGN_SYSTEM §4.4 — hue in
 * tints, never a saturated fill), plus the two quiet neutrals.
 */
export function tintedChip(tone: IconTone): { className: string; style: CSSProperties } {
  return {
    style: { '--tone': TONE_HEX[tone] } as CSSProperties,
    className: cn(
      'border-[color-mix(in_oklab,var(--tone)_50%,transparent)] bg-[color-mix(in_oklab,var(--tone)_16%,var(--color-surface-1))] text-[color-mix(in_oklab,var(--tone)_62%,black)]',
      'dark:bg-[color-mix(in_oklab,var(--tone)_22%,var(--color-surface-1))] dark:text-[color-mix(in_oklab,var(--tone)_70%,white)]',
    ),
  }
}

/** A break: a dashed edge over a soft diagonal stripe. */
export const BREAK_CHIP =
  'border-dashed border-border-strong/60 bg-[repeating-linear-gradient(135deg,var(--color-surface-2)_0_6px,var(--color-surface-3)_6px_12px)] text-ink-subtle'

/** Over or unavailable: present for context, clearly not for choosing. */
export const MUTED_CHIP = 'border-border-soft bg-surface-2 text-ink-subtle'

/** The chosen one: the primary gradient, lit edge and a glow. */
export const SELECTED_CHIP =
  'border-transparent bg-[image:var(--gradient-primary)] text-on-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_6px_16px_-6px_rgba(37,99,235,0.6)] ring-2 ring-primary-600/25 ring-offset-2 ring-offset-surface-1'
