/**
 * Small parts the record cards share: the 12/500 underlined text link
 * ("See all", "Why?") and the §8 clinical flag chip (icon + word, never
 * colour alone).
 */

import { ArrowDown, ArrowUp, Check, Info, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'

import { cn } from '../lib/cn'
import { Icon } from '../ui/primitives'

export function TextLink({ className, children, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-[28px] shrink-0 items-center rounded-[6px] px-[2px] text-[12px] font-medium text-sh-text-2 underline decoration-sh-line-strong underline-offset-[3px] transition-colors duration-150 hover:text-sh-text hover:decoration-current',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * §8 — the old build's clinical flag (`src/components/primitives.tsx`
 * `ClinicalFlag`) in this build's 22px chip: an icon and a word, never colour
 * alone. The arrow is the icon, so the glyphs in "↑↑ Critical high" are not
 * repeated in the word. A trend point's `high` / `low` / `critical` read the same.
 */
const FLAGS: Record<string, { icon: LucideIcon; word: string; cls: string }> = {
  Normal: { icon: Check, word: 'Normal', cls: 'sh-tone-norm' },
  '↑ High': { icon: ArrowUp, word: 'High', cls: 'sh-tone-warn' },
  '↓ Low': { icon: ArrowDown, word: 'Low', cls: 'sh-tone-warn' },
  '↑↑ Critical high': { icon: TriangleAlert, word: 'Critical high', cls: 'sh-tone-crit' },
  '↓↓ Critical low': { icon: TriangleAlert, word: 'Critical low', cls: 'sh-tone-crit' },
  high: { icon: ArrowUp, word: 'High', cls: 'sh-tone-warn' },
  low: { icon: ArrowDown, word: 'Low', cls: 'sh-tone-warn' },
  critical: { icon: TriangleAlert, word: 'Critical', cls: 'sh-tone-crit' },
}

export function ClinicalFlag({ flag, className }: { flag: string; className?: string }) {
  const f = FLAGS[flag] ?? { icon: Info, word: flag.replace(/^[↑↓]+\s*/, ''), cls: 'sh-tone-neu' }
  return (
    <span
      className={cn(
        f.cls,
        'inline-flex h-[22px] shrink-0 items-center gap-[4px] whitespace-nowrap rounded-full bg-(--t-bg) pl-[6px] pr-[8px] text-[12px]/none font-medium text-(--t-fg)',
        className,
      )}
    >
      <Icon icon={f.icon} size={12} strokeWidth={2.4} />
      {f.word}
    </span>
  )
}
