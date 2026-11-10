/**
 * The patient's record beside the video: the same cards as their record page
 * (record/RecordPage.tsx), so nothing reads differently here — their history
 * (condition, problems, allergies, medicines, last note, next due), test results,
 * vitals, the latest scan or document, the trend that matters and the earlier
 * consultation notes — under why they are here today and the prescription. The
 * whole record is the small Patient record link on the name card above.
 * The doctor reads it while the patient talks, without leaving the call.
 */

import { Pill as PillIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { vitalsHistoryFor } from '@/data/vitals-history'

import { useTrendSeries } from '../logic/record'
import { NotesCard } from '../record/NotesCard'
import { PatientReportCard } from '../record/PatientReportCard'
import { ReportCard } from '../record/ReportCard'
import { ResultsCard } from '../record/ResultsCard'
import { TrendCard } from '../record/TrendCard'
import { VitalsCard } from '../record/VitalsCard'
import { Card, Pill } from '../ui/primitives'

const SEX = { M: 'Male', F: 'Female', O: 'Other' } as const

export function VisitRecord({ patient: p, booking, encounterId }: { patient: Patient; booking?: { reason: string; scheduledAt: Date }; encounterId?: string }) {
  const navigate = useNavigate()
  const series = useTrendSeries(p)
  const first = p.name.split(' ')[0] || p.name
  return (
    <div className="flex min-w-0 flex-col gap-[16px]" aria-label={`${p.name}’s record`} data-visit-record="">
      <Card titleSize="sm" title={`About ${first}`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-[16px] gap-y-[8px] text-[14px] sm:grid-cols-[auto_1fr_auto_1fr]">
          <dt className="text-sh-text-3">Age</dt>
          <dd>
            {p.age} · {SEX[p.sex]}
          </dd>
          {booking && (
            <>
              <dt className="text-sh-text-3">Time</dt>
              <dd>{formatTime(booking.scheduledAt)}</dd>
              <dt className="text-sh-text-3">Visit for</dt>
              <dd className="sm:col-span-3">{booking.reason}</dd>
            </>
          )}
          <dt className="text-sh-text-3">Allergies</dt>
          <dd className={p.allergies.length ? 'font-medium text-sh-crit-fg sm:col-span-3' : 'sm:col-span-3'}>{p.allergies.length ? p.allergies.join(', ') : 'None known'}</dd>
        </dl>
        {encounterId && (
          <div className="mt-[14px] flex flex-wrap gap-[8px]">
            <Pill variant="primary" size="xl" icon={PillIcon} onClick={() => navigate(`/tele/session/${encounterId}/rx`)}>
              Write prescription
            </Pill>
          </div>
        )}
      </Card>

      <PatientReportCard patient={p} />
      <div className="grid grid-cols-1 gap-[16px] min-[1500px]:grid-cols-2">
        <ResultsCard patient={p} className="max-h-[360px]" />
        <VitalsCard patient={p} />
      </div>
      <ReportCard patient={p} />
      <TrendCard series={series} vitals={vitalsHistoryFor(p.id)} />
      <NotesCard patient={p} className="max-h-[420px]" />
    </div>
  )
}
