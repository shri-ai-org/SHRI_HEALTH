/**
 * The rest of a patient's record, one tap away — the old build's
 * `PatientRecordLinks` (`src/components/recordlinks.tsx`): a quiet label, then
 * a door only where there is something behind it (`recordLinksFor`), minus
 * the screen already open.
 */

import { Aperture, BookOpen, Brain, FlaskConical, ScrollText, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import type { Patient } from '@/data/kit'

import { cn } from '../lib/cn'
import { recordLinksFor, type RecordLinkKey } from '../logic/recordLinks'
import { Pill } from '../ui/primitives'

const DOOR_ICON: Record<RecordLinkKey, LucideIcon> = { record: BookOpen, results: FlaskConical, reports: ScrollText, imaging: Aperture, stroke: Brain }

export function RecordDoors({ patient: p, exclude = [], label = 'Record', className }: { patient: Patient; exclude?: RecordLinkKey[]; label?: string | null; className?: string }) {
  const navigate = useNavigate()
  const links = recordLinksFor(p).filter((l) => !exclude.includes(l.key))
  if (links.length === 0) return null
  return (
    // Wrapped rows sit 10px apart, so each 34px door keeps a 44px target of its own.
    <nav aria-label={`${p.name}’s record`} className={cn('flex flex-wrap items-center gap-x-[8px] gap-y-[10px]', className)}>
      {label && <span className="mr-[4px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{label}</span>}
      {links.map((l) => (
        <Pill key={l.key} variant="card" size="md" icon={DOOR_ICON[l.key]} onClick={() => navigate(l.to)}>
          {l.label}
        </Pill>
      ))}
    </nav>
  )
}
