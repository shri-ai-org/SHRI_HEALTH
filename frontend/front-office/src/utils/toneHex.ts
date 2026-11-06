import type { CSSProperties } from 'react'
import type { Tone } from './tone'

// Destination hues (DESIGN_SYSTEM §4.4, tier 2). Every navigation
// destination owns one; it appears on the nav glyph, the drawer tile, the
// dashboard section heading and the "Go to" tile, so a place is recognisable
// by colour AND shape. Used as SOFT TINTS — solid fills only on IconTile.

export type IconTone = 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'violet' | 'indigo' | 'cyan' | 'gray'

/** Each hue as its theme-aware token (shared/design-system.css) — softened
 *  mid-saturation colours with their own dark-mode values. A CSS colour
 *  value, so use it in styles and color-mix(); never parse it. */
export const TONE_HEX: Record<IconTone, string> = {
  blue: 'var(--color-hue-blue)',
  teal: 'var(--color-hue-teal)',
  green: 'var(--color-hue-green)',
  amber: 'var(--color-hue-amber)',
  orange: 'var(--color-hue-orange)',
  red: 'var(--color-hue-red)',
  pink: 'var(--color-hue-pink)',
  violet: 'var(--color-hue-violet)',
  indigo: 'var(--color-hue-indigo)',
  cyan: 'var(--color-hue-cyan)',
  gray: 'var(--color-ink-subtle)',
}

export function toneTint(tone: IconTone, alpha: number): string {
  return `color-mix(in oklab, ${TONE_HEX[tone]} ${Math.round(alpha * 1000) / 10}%, transparent)`
}

/** A card tinted in a tone. The tint is LAYERED over the element's own
 *  surface (keep a bg-surface-* class on it), so it stays opaque and
 *  theme-aware. 0.045 is the card-wash amount; ≤0.10 for buttons. */
export function tintedSurface(tone: IconTone, alpha = 0.08): CSSProperties {
  const tint = toneTint(tone, alpha)
  return {
    backgroundImage: `linear-gradient(${tint}, ${tint})`,
    borderColor: toneTint(tone, Math.min(alpha * 3.5, 0.45)),
  }
}

/** The destination hue for each semantic tone of the app's colour language. */
export const TONE_ICON: Record<Tone, IconTone> = {
  critical: 'red',
  warning: 'amber',
  stable: 'green',
  info: 'blue',
  brand: 'blue',
  neutral: 'gray',
  teal: 'teal',
  cyan: 'cyan',
  indigo: 'indigo',
  purple: 'violet',
  rose: 'pink',
}

/** A solid gradient chip in a hue (icon tile, avatar, count): pair with the
 *  `chip-solid` class, which reads `--tone`. */
export function toneVar(tone: IconTone): CSSProperties {
  return { '--tone': TONE_HEX[tone] } as CSSProperties
}
