/**
 * S-06-16 · Prescriptions — `/patient/:id/prescriptions` (`src/screens/m06/
 * record/S0616.tsx`): what the patient takes now, and every prescription
 * before it. "Taking now" is one list across every prescription on the
 * record, because that is the question at a follow-up. The history keeps each
 * prescription as it was written — a stopped drug stays visible with the
 * reason it stopped, which is what stops it being restarted by mistake.
 */

import { History, Pill as PillIcon, Signature } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'

import { encounterForPatient } from '@/data/clinical'
import { formatDate, formatTime } from '@/data/format'
import { clinicDate } from '../../../shri-health/format'
import type { Patient } from '@/data/kit'
import { activeMedicines, prescriptionsFor, type RxItem } from '@/data/record'
import { useClinical } from '@/store/clinical'

import { useMayOpenPath } from '../app/landing'
import { cn } from '../lib/cn'
import type { Tone } from '../mocks/types'
import { EmptyState } from '../ui/EmptyState'
import { Card, Chip, CountBubble, Icon, Pill } from '../ui/primitives'

import { RecordFrame } from './RecordFrame'
import { medicationsFor } from '../../../shri-health/medications'
import { encounterOfToday } from '../../../shri-health/opd'

const REAL_API = typeof __SHRI_REAL_API__ !== 'undefined' && __SHRI_REAL_API__

/** A day in the clinic's zone, U.S. style ("Nov 13, 2026"), with the API; the sample screens keep their own. */
function sinceDay(at: Date | string): string {
  return REAL_API ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(clinicDate(at)) : formatDate(typeof at === 'string' ? new Date(at) : at)
}

const STATUS_TONE: Record<RxItem['status'], Tone> = { Active: 'norm', Stopped: 'neu', Completed: 'neu' }

export function PrescriptionsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const may = useMayOpenPath()
  return (
    <RecordFrame
      id={id}
      section="prescriptions"
      actions={(p) => {
        // SHRI_HEALTH: with the API, today's visit from the status board (opened from the queue or My Day).
        const encounterId = REAL_API ? encounterOfToday(p.id) : encounterForPatient(p.id)?.id
        const to = encounterId && `/encounter/${encounterId}/rx`
        // Absent where the persona may not write one (GP-02) — a resident has no rx.write.
        return (
          to &&
          may(to) && (
            <Pill variant="primary" size="xl" icon={PillIcon} iconSize={17} onClick={() => navigate(to)}>
              Write prescription
            </Pill>
          )
        )
      }}
    >
      {(p) => <Prescriptions patient={p} />}
    </RecordFrame>
  )
}

function Prescriptions({ patient: p }: { patient: Patient }) {
  const rxStore = useClinical((s) => s.prescriptions)
  const enc = encounterForPatient(p.id)
  const today = enc ? rxStore[enc.id] : undefined
  // SHRI_HEALTH: with the API, the patient's medication list (listMedications); no sample prescriptions.
  const list = REAL_API ? medicationsFor(p.id) : undefined
  const active = list ? list.current : activeMedicines(p.id)
  const history = list ? list.history : prescriptionsFor(p.id)

  return (
    <>
      {today?.status === 'signed' && (
        <p role="status" className="flex items-center gap-[8px] rounded-[16px] bg-sh-norm-bg px-[16px] py-[12px] text-[14px] font-medium text-sh-norm-fg">
          <Icon icon={Signature} size={16} />
          Today’s prescription was signed{today.signedAt ? ` at ${formatTime(new Date(today.signedAt))}` : ''}
          {today.signedBy ? ` by ${today.signedBy}` : ''}.
        </p>
      )}

      <Card
        titleSize="sm"
        title={
          <span className="inline-flex items-center gap-[10px]">
            Taking now
            <CountBubble className={active.length > 0 ? 'bg-sh-pend-bg text-sh-pend-fg' : 'bg-sh-control'}>{active.length}</CountBubble>
          </span>
        }
      >
        {active.length === 0 ? (
          <EmptyState icon={PillIcon} why={`Nothing is currently prescribed for ${p.name}.`} />
        ) : (
          <ul className="flex flex-col">
            {active.map((m, i) => (
              <li
                key={`${m.drug}-${m.since.toISOString()}`}
                className={cn('flex flex-wrap items-start justify-between gap-[8px] py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}
              >
                <span className="min-w-0">
                  <span className="text-[14px] font-semibold text-sh-text">
                    {m.drug} <span className="font-normal">{m.dose}</span>
                  </span>
                  <span className="block text-[13px] text-sh-text-2">
                    {[m.route, m.frequency, m.duration].filter(Boolean).join(' · ')}
                  </span>
                  {m.note && <span className="block text-[12px] text-sh-text-3">{m.note}</span>}
                </span>
                <span className="text-[12px] tabular-nums text-sh-text-3">
                  since {sinceDay(m.since)} · {m.by}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        titleSize="sm"
        title={
          <span className="inline-flex items-center gap-[10px]">
            Prescription history
            <CountBubble className="bg-sh-control">{history.length}</CountBubble>
          </span>
        }
      >
        {history.length === 0 ? (
          <EmptyState icon={History} why="No earlier prescriptions are on the record." />
        ) : (
          <ol className="flex flex-col gap-[10px]">
            {history.map((r) => (
              <li key={r.id} className="rounded-[16px] bg-sh-inner px-[14px] py-[12px]">
                <p className="flex flex-wrap items-center justify-between gap-[8px]">
                  <span className="text-[14px] font-semibold text-sh-text">{r.context}</span>
                  <span className="text-[12px] tabular-nums text-sh-text-3">
                    {formatDate(r.at)} {formatTime(r.at)} · {r.by}
                  </span>
                </p>
                <ul className="mt-[8px] flex flex-col gap-[6px]">
                  {r.items.map((it) => (
                    <li key={it.drug} className="flex flex-wrap items-start justify-between gap-[8px] text-[13px]">
                      <span className={cn('min-w-0', it.status === 'Stopped' ? 'text-sh-text-3' : 'text-sh-text-2')}>
                        <span className={cn('font-medium text-sh-text', it.status === 'Stopped' && 'text-sh-text-3 line-through')}>{it.drug}</span>{' '}
                        {it.dose !== '—' && [it.dose, it.route, it.frequency].filter(Boolean).join(' · ')}
                        {it.note && <span className="block text-[12px] text-sh-text-3">{it.note}</span>}
                      </span>
                      <Chip word={it.status} tone={STATUS_TONE[it.status]} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  )
}
