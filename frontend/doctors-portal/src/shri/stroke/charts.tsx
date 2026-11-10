/**
 * Two stroke charts — ported from `src/components/charts.tsx` (SplitBar :417,
 * IndicatorBars :469), in theme tokens.
 *
 * `SplitBar`: two parts of one whole on one axis — the perfusion core and
 * penumbra, both segments directly labelled, because two quantities of the
 * same kind on two scales make their ratio meaningless.
 *
 * `IndicatorBars`: indicators against a target. One series, so no legend; the
 * target is a marker on the same axis rather than a second series, and met or
 * missed carries an icon and a word, never colour alone.
 */

import { Check, Target, TriangleAlert } from 'lucide-react'

import { cn } from '../lib/cn'
import { Icon, PillTag } from '../ui/primitives'

const SLOT = {
  1: { bar: 'bg-sh-crit-solid', ink: 'text-sh-on-crit-solid' },
  2: { bar: 'bg-sh-pend-fg', ink: 'text-sh-card' },
} as const

export function SplitBar({ parts, unit, caption }: { parts: { label: string; value: number; slot: 1 | 2 }[]; unit: string; caption?: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1
  return (
    <figure className="m-0">
      <div className="flex h-[32px] w-full gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
        {parts.map((p) => (
          <div key={p.label} style={{ width: `${(p.value / total) * 100}%` }} className={cn('flex items-center justify-center', SLOT[p.slot].bar)}>
            <span className={cn('px-[8px] text-[12px] font-bold tabular-nums', SLOT[p.slot].ink)}>{(p.value / total) * 100 >= 12 ? `${p.value}` : ''}</span>
          </div>
        ))}
      </div>
      <figcaption className="mt-[8px] flex flex-wrap gap-x-[16px] gap-y-[4px]">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-[6px] text-[13px]">
            <span aria-hidden="true" className={cn('block size-[10px] rounded-[2px]', SLOT[p.slot].bar)} />
            <span className="text-sh-text-2">{p.label}</span>
            <span className="font-semibold tabular-nums text-sh-text">
              {p.value} {unit}
            </span>
          </span>
        ))}
        {caption && <span className="text-[13px] text-sh-text-3">{caption}</span>}
      </figcaption>
    </figure>
  )
}

export function IndicatorBars({ rows }: { rows: { label: string; value: string; target: string; met: boolean; fraction: number }[] }) {
  return (
    <ul className="flex flex-col gap-[12px]">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
            <span className="text-[14px] font-medium text-sh-text">{r.label}</span>
            <span className="flex items-center gap-[8px]">
              <span className="font-semibold tabular-nums text-sh-text">{r.value}</span>
              <PillTag tone={r.met ? 'norm' : 'crit'} size="sm" icon={r.met ? Check : TriangleAlert}>
                {r.met ? 'Met' : 'Missed'}
              </PillTag>
            </span>
          </div>
          <div className="relative mt-[6px] h-[10px] overflow-hidden rounded-full bg-sh-inner" aria-hidden="true">
            <div className={cn('h-full rounded-full', r.met ? 'bg-sh-pend-fg' : 'bg-sh-crit-solid')} style={{ width: `${Math.min(100, r.fraction * 100)}%` }} />
            {/* The target, as a marker on the same axis — never a second scale. */}
            <span className="absolute inset-y-0 right-0 w-[2px] bg-sh-text-3" />
          </div>
          <p className="mt-[4px] flex items-center gap-[6px] text-[12px] text-sh-text-3">
            <Icon icon={Target} size={11} />
            target {r.target}
          </p>
        </li>
      ))}
    </ul>
  )
}
