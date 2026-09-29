/**
 * §5.7 — the month view's day popover, to the left of the calendar card: the
 * same `DayDetail` the week view draws inline, in a frosted popover. Hover
 * keeps it open; pinned it becomes a dialog with a close button and a focus
 * trap. Under 1024px (`sheet`) it is always pinned and rises as a bottom sheet.
 */

import { parseISO } from 'date-fns'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'

import { fmtLongDate } from '../lib/clock'
import { cn } from '../lib/cn'
import { popover, sheetUp } from '../lib/motion'
import { useShri } from '../state/store'
import { useFocusTrap } from '../ui/hooks'
import { RoundButton } from '../ui/primitives'

import { DayDetail } from './DayDetail'
import { useMyDay } from './useMyDay'

export function DayPeek({ iso, pinned, sheet, onEnter, onLeave }: { iso: string; pinned: boolean; sheet: boolean; onEnter: () => void; onLeave: () => void }) {
  const d = useMyDay()
  const closePeek = useShri((st) => st.closePeek)
  const date = parseISO(iso)
  const trap = useFocusTrap<HTMLDivElement>(pinned)

  return (
    <motion.div
      ref={trap}
      role="dialog"
      aria-modal={pinned || undefined}
      aria-label={fmtLongDate(date)}
      variants={sheet ? sheetUp : popover}
      initial="hidden"
      animate="shown"
      exit="exit"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={cn(
        'sh-frosted p-[16px] text-sh-text shadow-sh-pop',
        sheet
          ? 'fixed inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-sh-modal pb-[calc(16px_+_var(--sa-b))] pl-[max(16px,var(--sa-l))] pr-[max(16px,var(--sa-r))]'
          : 'absolute right-[calc(100%+14px)] top-0 max-h-[calc(100dvh-160px)] w-[360px] overflow-y-auto rounded-sh-card',
        pinned ? 'z-41' : 'z-30',
      )}
    >
      <DayDetail
        day={d.dayInfo(date)}
        onLeave={closePeek}
        headerEnd={pinned && <RoundButton icon={X} size={38} label="Close" onClick={closePeek} data-autofocus="true" className="ml-[2px]" />}
      />
    </motion.div>
  )
}
