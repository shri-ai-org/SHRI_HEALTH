/**
 * S-27-02 · Teleconsult queue — `/tele/queue` (`src/screens/m27/Telehealth.tsx`
 * S2702): today's teleconsults, the same list My Day's OPD tab draws them
 * from (`TELECONSULT_QUEUE`). With the AI on, AI-613's readiness order puts
 * the patients whose video is ready first; appointment time is one choice
 * away, and it is the only order with the AI off. A row opens the session.
 */

import { Check, DoorOpen, Phone, Video } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { TELECONSULT_QUEUE, maybeEncounter, type TeleRow } from '@/data/clinical'
import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'

import { ScreenFrame } from '../app/ScreenFrame'
import { useOpdLive } from '../logic/opd'
import { useAiActive } from '../state/ai'
import { Why } from '../ui/Disclosure'
import { Card, PillTag } from '../ui/primitives'
import { Worklist, type WorklistColumn } from '../ui/Worklist'

export function TeleQueuePage() {
  const navigate = useNavigate()
  const aiActive = useAiActive()
  const [aiSort, setAiSort] = useState(true)
  // The same live status My Day and the OPD queue show: joined → in session, ended or signed → seen.
  const live = useOpdLive()
  const liveOf = (patientId: string) => live.find((r) => r.patientId === patientId)?.live

  const byTime = [...TELECONSULT_QUEUE].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
  const rows = aiActive && aiSort ? [...byTime].sort((a, b) => Number(b.videoReady) - Number(a.videoReady)) : byTime

  const columns: WorklistColumn<TeleRow>[] = [
    { key: 'at', label: 'Scheduled', role: 'lead', cell: (r) => <span className="tabular-nums">{formatTime(r.scheduledAt)}</span> },
    { key: 'patient', label: 'Patient', role: 'primary', cell: (r) => patient(r.patientId).name },
    { key: 'reason', label: 'Reason', role: 'context', cell: (r) => r.reason },
    {
      key: 'video',
      label: 'Video',
      role: 'status',
      cell: (r) =>
        liveOf(r.patientId) === 'In room' ? (
          <PillTag tone="pend" size="sm" icon={DoorOpen}>
            in session
          </PillTag>
        ) : liveOf(r.patientId) === 'Seen' ? (
          <PillTag tone="norm" size="sm" icon={Check}>
            seen
          </PillTag>
        ) : r.videoReady ? (
          <PillTag tone="norm" size="sm" icon={Video}>
            ready
          </PillTag>
        ) : (
          <PillTag tone="warn" size="sm" icon={Phone}>
            telephone fallback
          </PillTag>
        ),
    },
  ]

  return (
    <ScreenFrame
      screenId="S-27-02"
      sub={`${TELECONSULT_QUEUE.length} today`}
      empty={
        <Card className="items-center p-[40px] text-center">
          <p className="text-[18px] font-medium">No teleconsults booked.</p>
          <p className="mx-auto mt-[8px] max-w-[448px] text-sh-text-3">A patient booking a teleconsult, or a follow-up converted to remote, would appear here.</p>
        </Card>
      }
      rail={
        <Why label="A telephone fallback is not a failure">
          <p>
            One patient has no working video. The consultation still happens by telephone, and the prescribing category gate is stricter for it — which the prescription screen
            enforces rather than trusting anyone to remember.
          </p>
        </Why>
      }
      railTitle="Teleconsult"
    >
      <Worklist
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        onOpen={(r) => navigate(`/tele/session/${maybeEncounter(r.id) ? r.id : r.patientId}`)}
        aiSort={aiSort}
        onSortChange={setAiSort}
        sortCapability="AI-613"
        aiSortLabel="Readiness"
        deterministicLabel="Appointment time"
        caption="Today's teleconsults"
        noun="teleconsults"
        emptyWhy="No teleconsults booked. A patient booking a teleconsult would appear here."
      />
    </ScreenFrame>
  )
}
