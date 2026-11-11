/**
 * S-18-09 · Team — `/stroke/case/:id/team` (`src/screens/m18/S1809.tsx`):
 * "Who was paged, and who actually answered."
 *
 * The distinction in the title is the whole screen: a paging system that
 * reports "team notified" when nobody picked up is worse than one that
 * reports nothing, because it stops anyone chasing. The unanswered page is
 * the default slice (`?scope=`); the answered ones are one tap away. The
 * escalation ladder and the case's figures fold behind one Why.
 *
 * Where the old screen fell short: a re-page wrote no record (it is audited,
 * and it holds for the session); "median" was the mean (it is the median);
 * the Escalate action was a span inside the row's button (it is a real
 * button beside the row); the index case's paging log was drawn on every
 * case; an unknown case id threw.
 */

import { Check, Clock, PhoneCall, TriangleAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { PAGING_LOG, type StrokeCase } from '@/data/stroke'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { minutesBetween, useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { useCaseClock } from '../logic/caseClock'
import { useScope } from '../logic/scope'
import { isIndexCase, pagingFor, useStrokeCaseParam } from '../logic/strokeCase'
import { useAiActive, useForcedState } from '../state/ai'
import { Alert } from '../ui/Alert'
import { Why } from '../ui/Disclosure'
import { Card, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { Worklist, type WorklistColumn } from '../ui/Worklist'

import { CaseClockStrip } from './CaseClockStrip'
import { NoStream, NoSuchCase } from './StrokeBits'
import { useStrokeLocal } from './strokeLocal'

const ESCALATION = [
  { step: 1, channel: 'Push notification', wait: '0 min' },
  { step: 2, channel: 'Automated call to the registered mobile', wait: '2 min' },
  { step: 3, channel: 'Call to the second contact on the rota', wait: '4 min' },
  { step: 4, channel: 'Switchboard pages the next person in the speciality', wait: '6 min' },
  { step: 5, channel: 'On-call consultant for the division is paged', wait: '10 min' },
]

type Page = (typeof PAGING_LOG)[number]
type Scope = 'unanswered' | 'answered'
const SCOPES: readonly Scope[] = ['unanswered', 'answered']

export function TeamPage() {
  const { id, strokeCase } = useStrokeCaseParam()
  if (!strokeCase) return <NoSuchCase screenId="S-18-09" id={id} />
  return <Team key={strokeCase.id} c={strokeCase} />
}

function Team({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const caseNow = useCaseClock()
  const running = useStroke((s) => s.running)
  const repaged = useStrokeLocal((s) => s.escalated[c.id]) ?? []
  const escalate = useStrokeLocal((s) => s.escalate)
  const [scope, setScope] = useScope(SCOPES, 'unanswered')

  const p = patient(c.patientId)
  const { log, acked, unanswered, medianAck } = pagingFor(c)
  const rows = scope === 'unanswered' ? unanswered : acked
  const clock = `/stroke/case/${c.id}/clock`

  function push(x: Page) {
    escalate(c.id, x.role)
    audit({
      event: 'STROKE.PAGE_ESCALATED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      at: caseNow.toISOString(),
      detail: `${c.caseNo} · ${x.role} (${x.name}) re-paged at ${formatTime(caseNow)} · paged ${formatTime(x.pagedAt)}, no answer · step 3, the second contact on the rota`,
      ...(forced === 'OFFLINE' ? { queued: true } : {}),
    })
    toast({ tone: 'caution', title: `${x.role} re-paged`, detail: 'Escalated to step 3 — the second contact on the rota is being called.' })
  }

  const columns: WorklistColumn<Page>[] = [
    { key: 'paged', label: 'Paged', role: 'lead', cell: (x) => formatTime(x.pagedAt) },
    {
      key: 'who',
      label: 'Role',
      role: 'primary',
      cell: (x) => (
        <>
          {x.role} <span className="font-normal text-sh-text-2">· {x.name}</span>
        </>
      ),
    },
    { key: 'channel', label: 'Channel', role: 'context', cell: (x) => x.channel },
    {
      key: 'waited',
      label: 'Waited',
      role: 'context',
      cell: (x) =>
        x.ackAt ? <span className="tabular-nums">answered in {minutesBetween(x.pagedAt, x.ackAt)} min</span> : <span className="font-medium tabular-nums text-sh-crit-fg">{minutesBetween(x.pagedAt, caseNow)} min, no answer</span>,
    },
    {
      key: 'status',
      label: 'Answered',
      role: 'status',
      cell: (x) =>
        x.ackAt ? (
          <PillTag tone="norm" size="sm" icon={Check}>
            answered {formatTime(x.ackAt)}
          </PillTag>
        ) : repaged.includes(x.role) ? (
          <PillTag tone="warn" size="sm" icon={PhoneCall}>
            escalated
          </PillTag>
        ) : null,
    },
  ]

  return (
    <ScreenFrame
      screenId="S-18-09"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Team"
      sub={`${acked.length} of ${log.length} answered · ${unanswered.length} no answer · median ${medianAck} min`}
      actions={
        may(clock) && (
          <Pill variant="card" size="xl" icon={Clock} iconSize={17} onClick={() => navigate(clock)}>
            Case clock
          </Pill>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-[20px]">
        {/* The operative alert: it exists only while someone has not answered. */}
        {unanswered.length > 0 && (
          <Alert tone="crit" icon={TriangleAlert} role="alert" title={`${unanswered[0].role} has not answered`}>
            {unanswered[0].name} was paged at {formatTime(unanswered[0].pagedAt)} on {unanswered[0].channel.toLowerCase()} — the ladder escalates on its own, or you can push it now.
          </Alert>
        )}

        {isIndexCase(c) ? (
          <Worklist
            rows={rows}
            columns={columns}
            rowKey={(x) => x.role}
            rowLabel={(x) => `${x.role}, ${x.name}, paged ${formatTime(x.pagedAt)}, ${x.ackAt ? `answered ${formatTime(x.ackAt)}` : 'no answer'}`}
            rowAction={(x) =>
              !x.ackAt && !repaged.includes(x.role) ? (
                <Pill variant="crit" size="lg" icon={PhoneCall} onClick={() => push(x)} aria-label={`Escalate — re-page the ${x.role.toLowerCase()}, ${x.name}`}>
                  Escalate
                </Pill>
              ) : null
            }
            caption="Team paging log"
            noun="pages"
            emptyWhy={scope === 'unanswered' ? 'Everyone paged for this case has answered.' : 'Nobody has answered yet. The ladder is running.'}
            filters={
              <Segmented
                label="Which to show"
                value={scope}
                onChange={setScope}
                options={[
                  { key: 'unanswered', label: 'Unanswered', icon: TriangleAlert, count: unanswered.length },
                  { key: 'answered', label: 'Answered', icon: Check, count: acked.length },
                ]}
              />
            }
          />
        ) : (
          <Card>
            <NoStream caseNo={c.caseNo} what="pages" />
          </Card>
        )}

        <Why label="How the ladder escalates, and how these times are stamped">
          <ol className="flex flex-col gap-[6px]">
            {ESCALATION.map((e) => (
              <li key={e.step} className="flex gap-[10px]">
                <span className="flex size-[20px] shrink-0 items-center justify-center rounded-full bg-sh-inner text-[12px] font-semibold text-sh-text">{e.step}</span>
                <span className="min-w-0 flex-1">
                  {e.channel} <span className="tabular-nums text-sh-text-3">· at {e.wait}</span>
                </span>
              </li>
            ))}
          </ol>
          <p>
            The ladder runs automatically. Nobody has to notice that nobody answered. On this case {log.length} were paged, {acked.length} answered, median {medianAck} min.
          </p>
          {aiActive && <p>AI-623 picks who to page from the live rota rather than a static list, so a swapped shift does not page someone asleep at home. It suggests; the coordinator can always page anyone.</p>}
          <p className="text-sh-text-3">
            The clock is {running ? 'running' : 'paused'} at {formatTime(caseNow)}. Paging times are stamped from the server, so an acknowledgement cannot be back-dated from a phone.
          </p>
        </Why>
      </div>
    </ScreenFrame>
  )
}
