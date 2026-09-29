/**
 * "My patients" — one rail item for the doctor's own lists, where the old
 * rail had two (OPD · Inpatients). Each list keeps its own address and screen
 * id (`/op-queue` S-05-03, `/ip/patients` S-08-03), so every old link, the My
 * Day counts and the flows land where they did; this frame is what they now
 * share: the one heading, and the pill tabs that move between them — the
 * record's tab pattern (`record/RecordTabs.tsx`), each tab its list's address,
 * each with its count. A list the persona cannot open is absent, never greyed.
 */

import { BedDouble, UserRound, type LucideIcon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { inpatientRows } from '@/data/admissions'
import { useAdmissions } from '@/store/admissions'
import { useClinical } from '@/store/clinical'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useOpdLive } from '../logic/opd'
import { CountBubble, Icon } from '../ui/primitives'

export type PatientsTab = 'opd' | 'ip'

const TABS: { key: PatientsTab; label: string; to: string; icon: LucideIcon }[] = [
  { key: 'opd', label: 'OPD', to: '/op-queue', icon: UserRound },
  { key: 'ip', label: 'Inpatients', to: '/ip/patients', icon: BedDouble },
]

function useTabCounts(): Record<PatientsTab, number> {
  const admissions = useAdmissions((s) => s.admissions)
  const discharges = useClinical((s) => s.discharges)
  // The OPD count is My Day's "Patients Today": the same live rows.
  const opd = useOpdLive().length
  const ip = useMemo(() => inpatientRows(admissions).filter((r) => !discharges[r.patientId]).length, [admissions, discharges])
  return { opd, ip }
}

function PatientsTabs({ current }: { current: PatientsTab }) {
  const navigate = useNavigate()
  const mayOpen = useMayOpenPath()
  const counts = useTabCounts()
  const tabs = TABS.filter((t) => mayOpen(t.to))
  if (tabs.length < 2) return null
  return (
    <div role="tablist" aria-label="My patients" className="-m-[4px] flex gap-[6px] overflow-x-auto p-[4px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map((t) => {
        const on = t.key === current
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={on ? 'patients-panel' : undefined}
            onClick={() => {
              if (!on) navigate(t.to)
            }}
            className={cn(
              'inline-flex h-[42px] shrink-0 items-center gap-[8px] rounded-full px-[16px] text-[14px] font-medium transition-colors duration-150',
              on ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-card text-sh-text hover:bg-sh-hover',
            )}
          >
            <Icon icon={t.icon} size={15} strokeWidth={2} />
            {t.label}
            <CountBubble active={on} className={on ? undefined : 'bg-sh-control'}>
              {counts[t.key]}
            </CountBubble>
          </button>
        )
      })}
    </div>
  )
}

export function MyPatientsFrame({
  tab,
  screenId,
  sub,
  actions,
  children,
}: {
  tab: PatientsTab
  screenId: string
  sub: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <ScreenFrame screenId={screenId} heading="My patients" sub={sub} actions={actions}>
      <div className="flex flex-col gap-[16px]">
        <PatientsTabs current={tab} />
        <div id="patients-panel" role="tabpanel" aria-label={tab === 'opd' ? 'OPD' : 'Inpatients'} className="flex flex-col gap-[16px]">
          {children}
        </div>
      </div>
    </ScreenFrame>
  )
}
