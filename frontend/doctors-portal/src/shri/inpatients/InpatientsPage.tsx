/**
 * S-08-03 · Inpatients — `/ip/patients` (`src/screens/m08/S0803.tsx`): "A
 * consultant's inpatient list, ordered by who needs them first." The
 * Inpatients tab of My patients (`patients/MyPatientsFrame.tsx`).
 *
 * Where My Day's Ward and ICU counts land, so it reads like My Day: the rows
 * carry the bed, the length of stay and why the patient sits where they do;
 * those needing attention are pinned first; the round note shows only where it
 * is signed (the count is in the subheading). The same two capabilities as My
 * Day — AI-613 orders the list, AI-201 scores deterioration — and with the AI
 * off the order is the chronological one and the risk goes, the facts stay.
 * `?location=ward|icu|ed` arrives from My Day's counts, so the list opens
 * narrowed, the narrowing visible and removable. Admissions still waiting for
 * a bed are listed above, as the front desk has them.
 */

import { Activity, BedDouble, Building2, Check, CircleAlert, CircleHelp, Hourglass, PenLine, Siren, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { PRIORITY_LABEL, PRIORITY_TONE, TYPE_LABEL, isAdmittedHere, pendingAdmissions, stageLabel, type Admission } from '@/data/admissions'
import { encounterForPatient, type WorklistRow } from '@/data/clinical'
import { ageSex } from '@/data/format'
import { patient } from '@/data/kit'
import { useAdmissions } from '@/store/admissions'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'

import { cn } from '../lib/cn'
import { recordPath } from '../logic/record'
import type { Tone } from '../mocks/types'
import { useInpatientsLive } from '../logic/inpatients'
import { MyPatientsFrame } from '../patients/MyPatientsFrame'
import { useAiActive } from '../state/ai'
import { EmptyState } from '../ui/EmptyState'
import { Card, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'
import { RankedSort } from '../ui/RankedSort'
import { Segmented } from '../ui/Segmented'

type Location = 'all' | 'ward' | 'icu' | 'ed'

/* VOCABULARY.md — `All` is the unfiltered slice on every list in the product. */
const LOCATIONS: { key: Location; label: string; icon?: LucideIcon }[] = [
  { key: 'all', label: 'All' },
  { key: 'ward', label: 'Ward', icon: BedDouble },
  { key: 'icu', label: 'ICU', icon: Activity },
  { key: 'ed', label: 'ED', icon: Siren },
]

const OLD_TONE: Record<'critical' | 'caution' | 'neutral', Tone> = { critical: 'crit', caution: 'warn', neutral: 'neu' }

function inLocation(row: WorklistRow, location: Location): boolean {
  const bed = row.bed ?? ''
  if (location === 'icu') return bed.startsWith('ICU')
  if (location === 'ed') return bed.startsWith('ED')
  if (location === 'ward') return bed !== '' && !bed.startsWith('ICU') && !bed.startsWith('ED')
  return true
}

/** AI-201's band, in words with its icon — never the colour alone; "cannot assess" is not a zero. */
function RiskChip({ risk }: { risk: WorklistRow['risk'] }) {
  if (risk === 'ABSTAIN')
    return (
      <PillTag tone="warn" size="sm" icon={CircleHelp}>
        Cannot assess
      </PillTag>
    )
  if (risk === 'HIGH')
    return (
      <PillTag tone="crit" size="sm" icon={TriangleAlert}>
        High risk
      </PillTag>
    )
  if (risk === 'MODERATE')
    return (
      <PillTag tone="warn" size="sm" icon={CircleAlert}>
        Moderate
      </PillTag>
    )
  if (risk === 'LOW')
    return (
      <PillTag tone="norm" size="sm" icon={Check}>
        Low risk
      </PillTag>
    )
  return null
}

export function InpatientsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const me = useCurrentStaff()
  const aiActive = useAiActive()
  const notes = useClinical((s) => s.notes)
  const admissions = useAdmissions((s) => s.admissions)
  const [aiSort, setAiSort] = useState(true)

  /** Everyone in a bed, less anyone discharged, in the one order My Day's list shares (`logic/inpatients.ts`). */
  const live = useInpatientsLive(aiSort)
  const inpatients = useMemo(() => live.map((r) => r.row), [live])
  const pending = useMemo(() => pendingAdmissions(admissions), [admissions])

  const raw = params.get('location')
  const location: Location = raw === 'ward' || raw === 'icu' || raw === 'ed' ? raw : 'all'
  const setLocation = (l: Location) => setParams(l === 'all' ? {} : { location: l }, { replace: true })

  const noteDone = (patientId: string) => {
    // Admitted here from OPD: their encounter is the clinic visit, so a signed OPD note is not a round note.
    if (isAdmittedHere(patientId, admissions)) return false
    const enc = encounterForPatient(patientId)
    return enc ? notes[enc.id]?.status === 'signed' : false
  }

  const inPlace = live.filter((r) => inLocation(r.row, location))
  const scoped = inPlace.map((r) => r.row)
  const pinned = inPlace.filter((r) => r.pinned).map((r) => r.row)
  // AI-613's order while it is live and chosen, otherwise the chronological one — decided once, for My Day too.
  const rows = inPlace.filter((r) => !r.pinned).map((r) => r.row)

  const outstanding = scoped.filter((r) => !noteDone(r.patientId)).length
  const highRisk = scoped.filter((r) => r.risk === 'HIGH').length

  const row = (r: WorklistRow, i: number, emphasis: boolean) => {
    const p = patient(r.patientId)
    return (
      <li key={r.patientId} className={cn(i > 0 && 'border-t border-sh-line')}>
        <button
          type="button"
          onClick={() => navigate(recordPath(p, 'record'))}
          className={cn(
            'relative flex min-h-[64px] w-full flex-wrap items-center gap-x-[12px] gap-y-[6px] rounded-[14px] px-[10px] py-[8px] text-left transition-colors duration-150 hover:bg-sh-hover',
            emphasis && 'bg-sh-crit-bg/40',
          )}
        >
          {/* A pinned row carries the priority hue as a left bar, never as a full tint. */}
          {emphasis && <span aria-hidden="true" className="absolute inset-y-[8px] left-0 w-[3px] rounded-r-full bg-sh-crit" />}
          <span className="inline-flex h-[32px] min-w-[72px] shrink-0 items-center justify-center rounded-[10px] bg-sh-inner px-[10px] text-[13px] font-bold tabular-nums text-sh-text-2">
            {r.bed ?? '—'}
          </span>
          <span className="min-w-0 flex-1 basis-[220px]">
            <span className="block truncate text-[15px] font-semibold text-sh-text">{p.name}</span>
            <span className="flex flex-wrap gap-x-[8px] text-[12px] text-sh-text-3">
              <span className="tabular-nums">
                {p.age}/{p.sex}
                {p.losDays !== undefined && ` · LOS ${p.losDays}d`}
              </span>
              {/* The one line that says WHY the row sits where it does — a charted fact, so it stays with the AI off. */}
              {r.risk !== 'ABSTAIN' && r.reason && <span>· {r.reason}</span>}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-[4px]">
            {aiActive && <RiskChip risk={r.risk} />}
            {/* Only the exception is marked; the count is in the subheading. */}
            {noteDone(r.patientId) && (
              <PillTag tone="norm" size="sm" icon={PenLine}>
                Note signed
              </PillTag>
            )}
          </span>
        </button>
      </li>
    )
  }

  const emptyWhy =
    location === 'all'
      ? 'No inpatients are assigned to you at this facility. An admission under your name, or being added to a care team, would put them here.'
      : `No inpatients of yours are in ${location === 'icu' ? 'the ICU' : location === 'ed' ? 'the ED' : 'a ward bed'} right now. Clearing the filter shows the rest of your list.`

  return (
    <MyPatientsFrame
      tab="ip"
      screenId="S-08-03"
      sub={`${scoped.length} under you${aiActive ? ` · ${highRisk} high risk` : ''} · ${outstanding} round ${outstanding === 1 ? 'note' : 'notes'} outstanding`}
    >
      <div className="flex max-w-[896px] flex-col gap-[16px]">
        {pending.length > 0 && <PendingAdmissions admissions={pending} />}

        <div className="flex flex-wrap items-center justify-between gap-[12px]">
          <div className="flex flex-wrap items-center gap-[10px]">
            <PillTag tone="neu" size="sm" icon={Building2}>
              {me.facilityCode}
            </PillTag>
            {/* The narrowing that arrived in the address, visible and removable. */}
            <Segmented
              label="Location"
              value={location}
              onChange={setLocation}
              options={LOCATIONS.map((l) => ({ key: l.key, label: l.label, icon: l.icon, count: inpatients.filter((r) => inLocation(r, l.key)).length }))}
            />
          </div>
          <RankedSort aiSort={aiSort} onChange={setAiSort} aiLabel="AI acuity" deterministicLabel="Chronological" capabilityId="AI-613" label="Sort the inpatients" />
        </div>

        <Card className="p-[8px]">
          {pinned.length + rows.length === 0 ? (
            <EmptyState
              icon={BedDouble}
              why={emptyWhy}
              action={
                location !== 'all' && (
                  <Pill variant="control" size="md" icon={X} onClick={() => setLocation('all')}>
                    All locations
                  </Pill>
                )
              }
            />
          ) : (
            <>
              <ul aria-label="Inpatients under this consultant" className="flex flex-col">
                {pinned.length > 0 && (
                  <li className="flex items-center gap-[8px] rounded-[12px] bg-sh-crit-bg px-[12px] py-[6px]">
                    <Icon icon={TriangleAlert} size={13} className="text-sh-crit-fg" />
                    <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-sh-crit-fg">Needs attention</span>
                    <CountBubble className="bg-sh-crit-solid text-sh-on-crit-solid">{pinned.length}</CountBubble>
                  </li>
                )}
                {pinned.map((r, i) => row(r, i, true))}
                {rows.map((r, i) => row(r, pinned.length + i, false))}
              </ul>
              <p className="border-t border-sh-line px-[10px] pb-[4px] pt-[10px] text-[12px] tabular-nums text-sh-text-3">
                {pinned.length + rows.length} {pinned.length + rows.length === 1 ? 'patient' : 'patients'}
                {pinned.length > 0 && ` · ${pinned.length} first`}
              </p>
            </>
          )}
        </Card>
      </div>
    </MyPatientsFrame>
  )
}

/**
 * The front desk's queue, as the doctor sees it: who they admitted, how
 * urgently, and where each admission has got to. A row opens the patient's
 * record; each patient moves into the list below once they have a bed.
 */
function PendingAdmissions({ admissions }: { admissions: Admission[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-[8px] bg-sh-warn-bg px-[16px] py-[8px]">
        <Icon icon={Hourglass} size={13} className="text-sh-warn-fg" />
        <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-sh-warn-fg">Pending admissions</h2>
        <CountBubble className="bg-sh-card text-sh-warn-fg">{admissions.length}</CountBubble>
      </div>
      <ol className="flex flex-col p-[8px]">
        {admissions.map((a, i) => {
          const p = patient(a.patientId)
          return (
            <li key={a.id} className={cn(i > 0 && 'border-t border-sh-line')}>
              <Link
                to={recordPath(p, 'record')}
                className="flex min-h-[60px] flex-wrap items-center gap-x-[12px] gap-y-[6px] rounded-[14px] px-[10px] py-[8px] transition-colors duration-150 hover:bg-sh-hover"
              >
                <span className="inline-flex h-[32px] min-w-[72px] shrink-0 items-center justify-center rounded-[10px] bg-sh-inner px-[10px] text-[13px] font-bold text-sh-text-2">
                  {TYPE_LABEL[a.type]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-sh-text">{p.name}</span>
                  <span className="block text-[12px] tabular-nums text-sh-text-3">
                    {ageSex(p.age, p.sex)} · {p.uhid}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-[4px]">
                  <PillTag tone={OLD_TONE[PRIORITY_TONE[a.priority]]} size="sm">
                    {PRIORITY_LABEL[a.priority]}
                  </PillTag>
                  <PillTag tone={a.bed ? 'pend' : 'warn'} size="sm" icon={a.bed ? BedDouble : Hourglass}>
                    {stageLabel(a)}
                  </PillTag>
                </span>
              </Link>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
