/**
 * §7.5 Patient report (row 2, right) — the patient's story on one surface
 * (`src/screens/m06/record/PatientReport.tsx`): the condition's status and
 * when it was updated, the story in two lines, then six facts, each one line
 * or a short list, never a paragraph — who they are here for, what is coded,
 * what they react to, what they take, what was last written and when they are
 * next due. The detail lives on the tabs above.
 */

import { Minus, TrendingDown, TrendingUp, TriangleAlert, Check, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { encounterForPatient } from '@/data/clinical'
import { formatDate, formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { activeMedicines, conditionFor, pastNotesFor, type ConditionStatus } from '@/data/record'

import { STATUS_TONE, useProblemsFor } from '../logic/record'
import { nextOf, useAppointments } from '../logic/schedule'
import { Card, PillTag, StatusPill } from '../ui/primitives'

const VISIT_WORD = { IP: 'Inpatient', OP: 'OPD', ED: 'ED', TELE: 'Teleconsult' } as const

/** The status's icon, so the word never rides on colour alone. */
const STATUS_ICON: Record<ConditionStatus, LucideIcon> = {
  Critical: TriangleAlert,
  Deteriorating: TrendingDown,
  Stable: Minus,
  Improving: TrendingUp,
  Recovered: Check,
}

export function PatientReportCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const c = conditionFor(p.id)
  const enc = encounterForPatient(p.id)
  const problems = useProblemsFor(p.id)
  const open = problems.filter((x) => x.status === 'Open')
  const meds = activeMedicines(p.id)
  const note = pastNotesFor(p.id)[0]
  // The live book: a moved or cancelled appointment is no longer the next one.
  const next = nextOf(useAppointments(), p.id)

  const visit = enc
    ? [VISIT_WORD[enc.type], enc.department, p.bed ?? enc.encounterNo, p.losDays !== undefined && `day ${p.losDays}`].filter(Boolean).join(' · ')
    : 'No open visit'

  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex flex-wrap items-center gap-[10px]">
          Patient report
          {c && <StatusPill icon={STATUS_ICON[c.status]} word={c.status} tone={STATUS_TONE[c.status]} className="font-semibold" />}
        </span>
      }
      right={c && <span className="text-[12px] tabular-nums text-sh-text-3">updated {formatDate(c.updatedAt)}</span>}
      className={className}
    >
      {/* The lead — the story in two lines. */}
      <div className="mb-[14px]">
        <div className="text-[14px]/[1.3] font-semibold text-sh-text">{c?.headline ?? p.scenario}</div>
        {c && <p className="sh-clamp-3 mt-[3px] text-[13px]/[1.45] text-sh-text-2">{c.summary}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-[8px] max-sm:grid-cols-1">
        <Fact label={enc?.type === 'IP' ? 'Admission' : 'Visit'} sub={[p.consultant, p.payer].filter(Boolean).join(' · ')}>
          {visit}
        </Fact>
        <Fact label="Problems" sub={problems.length > open.length ? `${problems.length - open.length} resolved` : undefined}>
          {open.length === 0 ? 'None coded yet' : open.slice(0, 3).map((x) => x.label).join(' · ')}
          {open.length > 3 && <span className="text-sh-text-3"> · +{open.length - 3} more</span>}
        </Fact>
        <Fact label="Allergies">
          {p.allergies.length === 0 ? (
            'None recorded'
          ) : (
            <span className="flex flex-wrap gap-[6px]">
              {p.allergies.map((a) => (
                <PillTag key={a} tone="crit" size="xs" icon={TriangleAlert} className="font-semibold">
                  {a}
                </PillTag>
              ))}
            </span>
          )}
        </Fact>
        <Fact label="Prescriptions" sub={meds[0] && `since ${formatDate(meds[0].since)} · ${meds[0].by}`}>
          {meds.length === 0 ? 'Nothing current' : meds.slice(0, 3).map((m) => `${m.drug} ${m.dose} ${m.frequency}`).join(' · ')}
          {meds.length > 3 && <span className="text-sh-text-3"> · +{meds.length - 3} more</span>}
        </Fact>
        <Fact label="Last note" sub={note && `${formatDate(note.at)} ${formatTime(note.at)} · ${note.by} · ${note.setting}`}>
          {note ? `${note.kind} — ${note.assessment}` : 'Nothing written yet'}
        </Fact>
        <Fact label="Next appointment" sub={next && `${next.clinic} · ${next.with}`}>
          {next ? (
            <span className="inline-flex flex-wrap items-center gap-[6px]">
              <span>
                {next.purpose} · {formatDate(next.at)} {formatTime(next.at)}
              </span>
              {next.status === 'Today' && (
                <PillTag tone="pend" size="xs" className="font-semibold">
                  Today
                </PillTag>
              )}
            </span>
          ) : (
            'Nothing booked'
          )}
        </Fact>
      </dl>
    </Card>
  )
}

/** Label over value, in a tile; the value takes two lines at most, the sub-line one. */
function Fact({ label, sub, children }: { label: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-[14px] bg-sh-inner px-[12px] py-[10px]">
      <dt className="text-[11px] text-sh-text-3">{label}</dt>
      <dd className="sh-clamp-2 mt-[2px] text-[13px] font-medium text-sh-text">{children}</dd>
      {sub && <dd className="mt-[2px] truncate text-[11px] tabular-nums text-sh-text-3">{sub}</dd>}
    </div>
  )
}
