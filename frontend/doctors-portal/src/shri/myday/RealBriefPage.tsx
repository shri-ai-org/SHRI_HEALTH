/**
 * SHRI_HEALTH: the morning brief on the API (D116; createMorningBrief, getMorningBrief) at `/brief`
 * (S-06-18): for each of the signed-in clinician's appointments today, a few lines about the
 * patient's chart, each linked to the record it comes from. A restricted chart the clinician may
 * not open is never read and says so. AI-generated and labelled so; it never changes the chart.
 * With the AI off, unavailable or over budget the page says the brief is unavailable and points
 * back to My Day; nothing else depends on it.
 */

import { Lock, RotateCcw, Sparkles, Sunrise } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { getPatientSummaries } from '../../../../src/api/generated/endpoints/patients/patients'
import type { MorningBrief, PatientSummaryList } from '../../../../src/api/generated/model'
import { formatNameGivenFirst } from '../../../../src/design-system/format/names'
import { morningBrief } from '../../../shri-health/aiChart'
import { aiSourceLabel, routeForAiSource } from '../../../shri-health/aiSources'
import { aiDownReason, useAiStatus } from '../../../shri-health/aiStatus'
import { clinicNow, formatTime } from '../../../shri-health/format'
import { ScreenFrame } from '../app/ScreenFrame'
import { Card, Pill, PillTag } from '../ui/primitives'

type Phase = { kind: 'loading' } | { kind: 'done'; brief: MorningBrief; names: Record<string, string> } | { kind: 'error'; message: string; down: boolean }

const today = () => {
  const d = clinicNow()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function namesOf(brief: MorningBrief): Promise<Record<string, string>> {
  const ids = [...new Set(brief.appointments.map((a) => a.patientId))].slice(0, 50)
  if (ids.length === 0) return {}
  const found = (await getPatientSummaries({ patientIds: ids })).data as PatientSummaryList
  return Object.fromEntries(found.items.map((p) => [p.id, formatNameGivenFirst(p.name)]))
}

export function RealBriefPage() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [run, setRun] = useState(0)

  useEffect(() => {
    let live = true
    setPhase({ kind: 'loading' })
    morningBrief(today())
      .then(async (brief) => {
        const names = await namesOf(brief).catch(() => ({}))
        if (live) setPhase({ kind: 'done', brief, names })
      })
      .catch((error: unknown) => {
        const down = aiDownReason(error)
        if (down) useAiStatus.getState().markDown('morning-brief', down)
        if (live) setPhase({ kind: 'error', message: down ?? (error instanceof Error ? error.message : 'The brief did not arrive.'), down: down !== null })
      })
    return () => {
      live = false
    }
  }, [run])

  return (
    <ScreenFrame screenId="S-06-18" sub="Your appointments today, with what each chart says to know first. AI-generated; check the linked records before acting.">
      <div className="flex max-w-[960px] flex-col gap-[16px]">
        {phase.kind === 'loading' && (
          <Card>
            <p role="status" className="text-[14px] text-sh-text-2">
              Reading today&rsquo;s charts…
            </p>
          </Card>
        )}
        {phase.kind === 'error' && (
          <Card>
            <p role="alert" className="text-[14px] text-sh-warn-fg">
              {phase.down ? 'The morning brief is unavailable right now.' : phase.message}
            </p>
            <div className="mt-[10px] flex gap-[8px]">
              {!phase.down && (
                <Pill variant="control" size="md" icon={RotateCcw} onClick={() => setRun((n) => n + 1)}>
                  Try again
                </Pill>
              )}
              <Pill variant="control" size="md" onClick={() => navigate('/')}>
                Back to My Day
              </Pill>
            </div>
          </Card>
        )}
        {phase.kind === 'done' && phase.brief.appointments.length === 0 && (
          <Card className="items-center text-center">
            <Sunrise size={22} className="text-sh-muted" aria-hidden />
            <p className="mt-[8px] text-[15px] text-sh-text">No appointments with you today.</p>
          </Card>
        )}
        {phase.kind === 'done' && phase.brief.appointments.length > 0 && (
          <>
            <PillTag tone="neu" size="xs" icon={Sparkles} className="self-start font-medium">
              AI-generated · {phase.brief.generatedBy.modelName}
            </PillTag>
            {phase.brief.appointments.map((a) => (
              <Card key={a.appointmentId} titleSize="sm" title={`${formatTime(a.startAt)} · ${phase.names[a.patientId] ?? 'Patient'}`}>
                {a.chartStatus === 'restricted' && (
                  <p className="flex items-center gap-[8px] text-[13px] text-sh-text-2">
                    <Lock size={14} aria-hidden /> Restricted chart: not read for the brief.
                  </p>
                )}
                {a.chartStatus === 'nothing-recorded' && <p className="text-[13px] text-sh-text-2">Nothing recorded on the chart yet.</p>}
                {a.chartStatus === 'summarized' && a.statements.length === 0 && <p className="text-[13px] text-sh-text-2">Nothing to flag from the chart.</p>}
                {a.chartStatus === 'summarized' && a.statements.length > 0 && (
                  <ul className="flex flex-col gap-[8px]">
                    {a.statements.map((st) => (
                      <li key={st.sequence} className="flex flex-col gap-[2px]">
                        <p className="text-[14px]/[1.4] text-sh-text">{st.text}</p>
                        <span className="flex flex-wrap gap-x-[10px]">
                          {st.sources.map((src, j) => (
                            <button
                              key={`${src.resourceId}-${j}`}
                              type="button"
                              onClick={() => navigate(routeForAiSource(a.patientId, src))}
                              className="text-[12px] font-medium text-sh-ai underline-offset-2 hover:underline"
                              aria-label={`Source: ${aiSourceLabel(src)}`}
                            >
                              {aiSourceLabel(src)}
                            </button>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
          </>
        )}
      </div>
    </ScreenFrame>
  )
}
