import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * The `sh-*` colour names are bridged from `tokens.css`; tailwind-merge needs
 * to know they are colours so `bg-sh-card` and `bg-sh-inner` collapse to the
 * last one written rather than both surviving.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: [
        'sh-surface', 'sh-frame', 'sh-card', 'sh-inner', 'sh-control', 'sh-hover', 'sh-hover-strong',
        'sh-line', 'sh-line-strong', 'sh-text', 'sh-text-2', 'sh-text-3', 'sh-muted', 'sh-chev', 'sh-rail',
        'sh-accent', 'sh-accent-soft', 'sh-accent-ink', 'sh-accent-2', 'sh-ai', 'sh-primary', 'sh-primary-hover',
        'sh-on-primary', 'sh-crit', 'sh-crit-bg', 'sh-crit-fg', 'sh-warn', 'sh-warn-bg', 'sh-warn-fg',
        'sh-norm', 'sh-norm-bg', 'sh-norm-fg', 'sh-pend', 'sh-pend-bg', 'sh-pend-fg', 'sh-neu-bg', 'sh-neu-fg', 'sh-scrim',
      ],
      shadow: ['sh-frame', 'sh-pop', 'sh-drawer', 'sh-modal', 'sh-glow'],
      radius: ['sh-card', 'sh-kpi', 'sh-modal', 'sh-surface', 'sh-inner'],
      font: ['sh', 'sh-tamil', 'sh-serif'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
