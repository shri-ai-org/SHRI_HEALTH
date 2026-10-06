/**
 * §7.4 — the record's parts as 42px pill tabs, gap 6, scrolling sideways
 * without a scrollbar: the old build's seven (Overview · Condition · Test
 * results · Imaging reports · Consultation notes · Prescriptions ·
 * Appointments), each with its count, each one
 * tap from every other (`src/screens/m06/record/shared.tsx` `RecordNav`). A tab
 * goes to its part's own address. Active: `--primary` + accent count bubble;
 * inactive: `--card` + `--control` bubble. The scroller clips, so it carries 4px
 * of room on every side (given back by a negative margin): the tabs' 44px hit
 * areas and their focus rings fit inside.
 */

import { useNavigate } from 'react-router-dom'

import type { Patient } from '@/data/kit'

import { cn } from '../lib/cn'
import { SECTION_META, SECTION_ORDER, recordPath, useSectionCounts, type RecordSection } from '../logic/record'
import { CountBubble } from '../ui/primitives'

export function RecordTabs({ patient: p, current }: { patient: Patient; current: RecordSection }) {
  const navigate = useNavigate()
  const counts = useSectionCounts(p)
  return (
    <div
      role="tablist"
      aria-label={`Parts of ${p.name}’s record`}
      className="-m-[4px] flex gap-[6px] overflow-x-auto p-[4px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {SECTION_ORDER.map((key) => {
        const on = key === current
        const count = key === 'record' ? undefined : counts[key]
        return (
          <button
            key={key}
            id={`record-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={on ? 'record-panel' : undefined}
            onClick={() => {
              if (!on) navigate(recordPath(p, key))
            }}
            className={cn(
              'inline-flex h-[42px] shrink-0 items-center gap-[8px] rounded-full px-[16px] text-[14px] font-medium transition-colors duration-150',
              on ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-card text-sh-text hover:bg-sh-hover',
            )}
          >
            {SECTION_META[key].short}
            {count !== undefined && (
              <CountBubble active={on} className={on ? undefined : 'bg-sh-control'}>
                {count}
              </CountBubble>
            )}
          </button>
        )
      })}
    </div>
  )
}
