/**
 * §6.3 / GP-03 — patient search. Opens from the rail button or `/`. One kind
 * of result, because a doctor at the search box is looking for a patient:
 * screens are in the nav, and orders and results live on the patient's
 * record. The old palette's rule (`src/shell/OverlayHost.tsx` `SearchPalette`):
 * the first six of the sample-data kit until the doctor types, then everyone
 * whose name or UHID contains the query, eight at most — AI-901 "returns
 * nothing the caller cannot already read". Arrows move the highlight, Enter
 * opens the record.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, Search } from 'lucide-react'
import { useId, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { PATIENTS, type Patient } from '@/data/kit'

import { P } from '../app/paths'
import { cn } from '../lib/cn'
import { initials } from '../lib/initials'
import { useShri } from '../state/store'
import { useModalFrame } from '../ui/frames'
import { useFocusTrap } from '../ui/hooks'
import { Avatar, Icon } from '../ui/primitives'

export function PatientSearch() {
  const open = useShri((s) => s.searchOpen)
  return <AnimatePresence>{open && <Palette key="search" />}</AnimatePresence>
}

function matches(q: string): Patient[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return PATIENTS.slice(0, 6)
  return PATIENTS.filter((p) => p.name.toLowerCase().includes(needle) || p.uhid.toLowerCase().includes(needle)).slice(0, 8)
}

function Palette() {
  const close = useShri((s) => s.closeSearch)
  const navigate = useNavigate()
  const ref = useFocusTrap<HTMLDivElement>(true)
  const frame = useModalFrame(560, 'top')
  const listId = useId()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)

  const typed = q.trim() !== ''
  const rows = matches(q)
  const hi = Math.min(active, Math.max(rows.length - 1, 0))

  function open(p: Patient) {
    close()
    navigate(P.record(p.uhid))
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(Math.min(hi + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(Math.max(hi - 1, 0))
    } else if (e.key === 'Enter' && rows[hi]) {
      e.preventDefault()
      open(rows[hi])
    }
  }

  return (
    <div className={cn(frame.outer, 'z-60')} style={frame.outerStyle}>
      <motion.div
        ref={ref}
        role="dialog"
        aria-label="Patient search"
        variants={frame.variants}
        initial="hidden"
        animate="shown"
        exit="exit"
        className={cn('rounded-[24px] bg-sh-card p-[12px] pb-[10px] text-sh-text shadow-sh-modal', frame.inner)}
      >
        <div className="relative">
          <Icon icon={Search} size={18} className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2 text-sh-text-3" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKey}
            data-autofocus="true"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows[hi] ? `${listId}-${hi}` : undefined}
            aria-autocomplete="list"
            aria-label="Patient search"
            aria-describedby={`${listId}-hint`}
            placeholder="R. Lakshmanan · ISH-0044051"
            autoComplete="off"
            spellCheck={false}
            className="h-[52px] w-full rounded-full bg-sh-control pl-[48px] pr-[18px] text-[14px] text-sh-text placeholder:text-sh-muted"
          />
        </div>

        <p id={`${listId}-hint`} className="mt-[10px] px-[12px] text-[12px] text-sh-text-3">
          Name or UHID · type / from anywhere
        </p>
        <p className="mt-[10px] px-[12px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{typed ? 'Results' : 'Patients'}</p>

        {rows.length === 0 ? (
          <p className="px-[12px] pb-[8px] pt-[10px] text-[13px] text-sh-text-2">
            Nothing matched. Only the {PATIENTS.length} patients in the sample-data kit exist here — the atlas forbids inventing another.
          </p>
        ) : (
          <ul id={listId} role="listbox" aria-label={typed ? 'Results' : 'Patients'} className="mt-[6px] flex flex-col gap-[2px]">
            {rows.map((p, i) => (
              <li key={p.id} id={`${listId}-${i}`} role="option" aria-selected={i === hi}>
                <Link
                  to={P.record(p.uhid)}
                  onClick={close}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    'flex h-[52px] items-center gap-[12px] rounded-[16px] px-[10px] text-sh-text transition-colors duration-150',
                    i === hi ? 'bg-sh-hover-strong' : 'hover:bg-sh-hover',
                  )}
                >
                  <Avatar initials={initials(p.name)} variant="pend" size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{p.name}</span>
                    <span className="block truncate text-[12px] tabular-nums text-sh-text-3">
                      {p.uhid} · {p.age}/{p.sex} · {p.bed ?? 'outpatient'}
                    </span>
                  </span>
                  <Icon icon={ChevronRight} size={16} className="text-sh-chev" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </motion.div>
    </div>
  )
}
