/**
 * How the day timeline draws each kind of time — shared by the row
 * (`DayTimeline`) and the panel's key and cards (`TodayPanel`).
 */

import type { CSSProperties } from 'react'

import type { ActivityKind } from './dayModel'

/** An activity's colour and ink, with a lit top edge — an edge, not a wash, so the ink keeps its contrast. */
export const actStyle = (k: ActivityKind): CSSProperties => ({
  background: `var(--act-${k})`,
  color: `var(--act-${k}-ink)`,
  boxShadow: k === 'brief' ? 'inset 0 0 0 1.5px var(--act-brief-edge)' : 'inset 0 1px 0 rgb(255 255 255 / 0.28)',
})
export const HATCH_OFF = 'bg-[repeating-linear-gradient(135deg,var(--off-hatch)_0_2px,var(--off-fill)_2px_8px)]'
export const HATCH_BLOCKED = 'bg-[repeating-linear-gradient(135deg,var(--crit-bg)_0_6px,transparent_6px_10px)]'
export const FREE = 'border-[1.5px] border-dashed border-(--avail-edge) bg-(--avail-fill) text-(--avail-ink)'
