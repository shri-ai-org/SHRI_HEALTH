/**
 * §7 — S-06-11 Patient record, Overview (`/patient/:id`): one patient on one
 * page (`src/screens/m06/record/S0611.tsx`) — the latest scan or document, the
 * vitals, the AI's readings, how the results fall, the one trend that matters
 * and the patient's report, with each part of the record one tab away.
 *
 * Banner → header → tabs → cards. Every card is on every record, in the same
 * place — row one 5:4:4 (viewer · vitals over AI insights · results), row two
 * 1:1 (trend · patient report) — so the page never reflows between patients:
 * a card with nothing to show keeps its size and header and says so. Below
 * `lg` everything stacks. The AI card sits under Vitals and takes the height
 * the row already has, scrolling inside, rather than stretching the row.
 */

import { BedDouble, Clock, DoorOpen, Stethoscope, Video } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'

import { can } from '@/atlas/personas'
import { canAdmit } from '@/data/admissions'
import type { Patient } from '@/data/kit'
import { formatTime } from '@/data/format'
import { useAdmissions } from '@/store/admissions'
import { useClinical } from '@/store/clinical'
import { useSession } from '@/store/session'

import { useMayOpenPath } from '../app/landing'
import { inpatientBed } from '../logic/discharge'
import { consultPath, noteActionLabel, useTrendSeries } from '../logic/record'
import { useDischargeFlow } from '../state/dischargeFlow'
import { useShri } from '../state/store'
import { Pill, PillTag } from '../ui/primitives'

import { InsightsCard } from './InsightsCard'
import { PatientReportCard } from './PatientReportCard'
import { RecordFrame } from './RecordFrame'
import { ReportCard } from './ReportCard'
import { ResultsCard } from './ResultsCard'
import { TrendCard } from './TrendCard'
import { VitalsCard } from './VitalsCard'

export function RecordPage() {
  const { id } = useParams()
  return (
    <RecordFrame id={id} section="record" actions={(p) => <HubActions patient={p} />}>
      {(p) => <Hub patient={p} />}
    </RecordFrame>
  )
}

/** Timeline · Connect · Admit · the note — each absent where the persona cannot go, Admit absent once the patient is in or on the way into a bed. */
function HubActions({ patient: p }: { patient: Patient }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const admissions = useAdmissions((s) => s.admissions)
  const openAdmit = useShri((s) => s.openAdmit)
  const openDischarge = useDischargeFlow((s) => s.open)
  const persona = useSession((s) => s.persona)
  const discharged = useClinical((s) => s.discharges[p.id])
  const timeline = `/patient/${p.uhid}/timeline`
  // One click into Telehealth, with this patient already loaded.
  const connect = `/tele/session/${p.uhid}`
  const consult = consultPath(p)
  return (
    <>
      {may(timeline) && (
        <Pill variant="card" size="xl" icon={Clock} iconSize={17} onClick={() => navigate(timeline)}>
          Timeline
        </Pill>
      )}
      {may(connect) && (
        <Pill variant="card" size="xl" icon={Video} iconSize={17} title="Telehealth" onClick={() => navigate(connect)}>
          Connect
        </Pill>
      )}
      {canAdmit(p, admissions) && (
        <Pill variant="card" size="xl" icon={BedDouble} iconSize={17} onClick={() => openAdmit(p.id)}>
          Admit
        </Pill>
      )}
      {/* Discharge sits beside Admit: for an admitted patient, to those who may discharge; once done, what happened instead. */}
      {discharged ? (
        <PillTag tone="neu" size="sm" icon={DoorOpen} className="font-semibold">
          {discharged.kind === 'transfer' ? 'Transferred' : discharged.kind === 'lama' ? 'Left against advice' : discharged.kind === 'death' ? 'Died' : 'Discharged'} {formatTime(new Date(discharged.at))}
        </PillTag>
      ) : (
        inpatientBed(p.id, admissions) &&
        can(persona, 'discharge.write') && (
          <Pill variant="card" size="xl" icon={DoorOpen} iconSize={17} onClick={() => openDischarge(p.id)}>
            Discharge
          </Pill>
        )
      )}
      {consult && may(consult) && (
        <Pill variant="primary" size="xl" icon={Stethoscope} iconSize={17} onClick={() => navigate(consult)}>
          {noteActionLabel(p)}
        </Pill>
      )}
    </>
  )
}

function Hub({ patient: p }: { patient: Patient }) {
  const series = useTrendSeries(p)
  return (
    <>
      {/* The first screen: the scan, the vitals and the AI's flags, and how the results fall — none of them below the fold. */}
      <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-[5fr_4fr_4fr]">
        <ReportCard patient={p} />
        <div className="flex min-w-0 flex-col gap-[16px]">
          <VitalsCard patient={p} />
          {/* Beside the other two it takes the row's height without setting it, and scrolls inside; never below a readable 260px. */}
          <div className="flex min-h-0 flex-col lg:h-0 lg:min-h-[260px] lg:grow">
            <InsightsCard patient={p} className="min-h-0 flex-1" />
          </div>
        </div>
        <ResultsCard patient={p} />
      </div>

      {/* Below: the one trend that matters, and the patient's report. */}
      <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-2">
        <TrendCard series={series} />
        <PatientReportCard patient={p} />
      </div>
    </>
  )
}
