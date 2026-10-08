/**
 * S-27-03 · Video visit — `/tele/session/:id`. Keyed by a teleconsult from the
 * Video visits list, or a patient (SD id or UHID) from their record; an unknown
 * id says so.
 *
 * One page, three moments, in plain words:
 *   before the call  one button; the patient's recording consent, from the patient portal (VisitSetup)
 *   in the call      the video itself, who and how long, Start recording, the conversation as it is said
 *                    (InCall, JitsiRoom, Conversation)
 *   after the call   the downloads, the notes, and Mark visit as done (AfterVisit)
 * Beside them, always: who the patient is, why they are here, and the doctor's notes.
 * The call is the consultation, so there is no Start consultation here; the notes
 * are written beside the call.
 *
 * The video is a Jitsi room inside this page — the visit's own, private — so the
 * doctor never leaves Shri Health. The recording and the conversation are this
 * page's (capture.ts), kept on the server (teleStore.ts).
 */

import { Pill as PillIcon, UserRound } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { P } from '../app/paths'
import { teleParty } from '../logic/tele'
import { useOpd } from '../state/opd'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { cn } from '../lib/cn'
import { Card, Pill } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

import { AfterVisit } from './AfterVisit'
import { stopCapture } from './capture'
import { Conversation } from './Conversation'
import { InCall } from './InCall'
import { newRoomName, roomUrl } from './jitsi'
import { NoParty } from './NoParty'
import type { RecordHeader } from './visitRecord'
import { visitFor } from './visits'
import { consentOf, useTele } from './teleStore'
import { STATUS_CLASS, STATUS_WORD, useVisitStatus } from './visitStatus'
import { VisitSetup } from './VisitSetup'

const SEX = { M: 'Male', F: 'Female', O: 'Other' } as const

export function TeleSessionPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useUI((s) => s.toast)
  const me = useCurrentStaff()
  const [ending, setEnding] = useState(false)
  const [newCall, setNewCall] = useState(false)
  // Starting the call puts the patient in the room on every OPD card; ending it makes them Seen.
  const startOpd = useOpd((s) => s.start)
  const finishOpd = useOpd((s) => s.finish)

  const party = teleParty(id)
  const pid = party?.patient.id ?? ''
  const tele = useTele.getState
  const activeSid = useTele((s) => (s.activeSid && s.sessions[s.activeSid]?.patientId === pid ? s.activeSid : undefined))
  const shown = useTele((s) => {
    const sid = activeSid ?? s.latest[pid]
    return sid ? s.sessions[sid] : undefined
  })
  const capturing = useTele((s) => Boolean(activeSid && s.live?.sid === activeSid))
  const notes = useTele((s) => s.notes[pid] ?? '')
  const consent = useTele((s) => consentOf(s, pid))
  const statusOf = useVisitStatus()

  if (!party) return <NoParty screenId="S-27-03" id={id} />
  const { patient: p, encounter: enc } = party
  const first = p.name.split(' ')[0] || p.name
  const booking = visitFor(p.id)
  const status = statusOf(p.id)
  const mode = activeSid ? 'call' : shown && !newCall ? 'after' : 'setup'

  const header: RecordHeader | undefined = shown && {
    patient: p.name,
    uhid: p.uhid,
    doctor: me?.name,
    startedAt: shown.startedAt,
    endedAt: shown.endedAt,
    meetUri: shown.meetUri,
    consent: shown.consent === 'given' ? 'given by the patient, in the patient portal' : 'not given',
  }

  async function start() {
    const other = tele().activeSid
    if (other) {
      await stopCapture()
      tele().end(other)
    }
    // The visit's own room, which no one can guess; the patient portal is what tells the patient to join it.
    const room = newRoomName(booking?.id ?? p.id)
    tele().begin({ patientId: p.id, encounterId: enc?.id, meetUri: roomUrl(room), meetCode: room, consent: consent ?? 'declined' })
    setNewCall(false)
    startOpd(p.id)
  }

  async function endCall(asked: boolean) {
    setEnding(false)
    const sid = activeSid
    await stopCapture()
    if (sid) tele().end(sid)
    toast({ tone: 'success', title: 'Call ended', detail: asked ? 'Finish your notes, then mark the visit done.' : `You left the video. Finish your notes, then mark the visit done.` })
  }

  return (
    <ScreenFrame
      screenId="S-27-03"
      patient={p}
      heading="Video visit"
      sub={booking ? `Booked for ${formatTime(booking.scheduledAt)} · ${booking.reason}` : undefined}
      chips={
        <span className={cn('inline-flex h-[28px] items-center rounded-full px-[12px] text-[13px] font-semibold', STATUS_CLASS[status])} data-visit-status={status}>
          {STATUS_WORD[status]}
        </span>
      }
    >
      <div className="grid items-start gap-[16px] lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-[16px]">
          {mode === 'setup' && <VisitSetup firstName={first} consent={consent} onStart={() => void start()} />}
          {mode === 'call' && activeSid && shown && (
            <>
              <InCall
                sid={activeSid}
                patientId={p.id}
                firstName={first}
                room={shown.meetCode ?? newRoomName(shown.id)}
                doctorName={me?.name ?? 'Doctor'}
                startedAt={shown.startedAt}
                onEnd={() => setEnding(true)}
                onLeftRoom={() => void endCall(false)}
              />
              {consent === 'given' && header && <Conversation sid={activeSid} firstName={first} header={header} />}
            </>
          )}
          {mode === 'after' && shown && header && (
            <>
              <AfterVisit
                sid={shown.id}
                header={header}
                note={notes}
                firstName={first}
                done={status === 'done'}
                onDone={() => {
                  tele().markDone(p.id)
                  finishOpd(p.id)
                  toast({ tone: 'success', title: 'Visit done', detail: `${p.name}’s video visit is finished.` })
                }}
                onReopen={() => tele().reopen(p.id)}
                onNewCall={() => setNewCall(true)}
              />
              {shown.segments.length > 0 && <Conversation sid={shown.id} firstName={first} header={header} />}
            </>
          )}
        </div>

        <div className="flex flex-col gap-[16px]">
          <Card titleSize="sm" title={`About ${first}`}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-[16px] gap-y-[8px] text-[14px]">
              <dt className="text-sh-text-3">Age</dt>
              <dd>
                {p.age} · {SEX[p.sex]}
              </dd>
              {booking && (
                <>
                  <dt className="text-sh-text-3">Visit for</dt>
                  <dd>{booking.reason}</dd>
                  <dt className="text-sh-text-3">Time</dt>
                  <dd>{formatTime(booking.scheduledAt)}</dd>
                </>
              )}
              <dt className="text-sh-text-3">Allergies</dt>
              <dd className={p.allergies.length ? 'font-medium text-sh-crit-fg' : undefined}>{p.allergies.length ? p.allergies.join(', ') : 'None known'}</dd>
            </dl>
            <div className="mt-[14px] flex flex-wrap gap-[8px]">
              <Pill variant="control" size="xl" icon={UserRound} onClick={() => navigate(P.record(p.uhid))}>
                Patient record
              </Pill>
              {enc && (
                <Pill variant="primary" size="xl" icon={PillIcon} onClick={() => navigate(`/tele/session/${enc.id}/rx`)}>
                  Write prescription
                </Pill>
              )}
            </div>
          </Card>

          <Card titleSize="sm" title="Your notes">
            <VoiceField
              id="tele-note"
              layout="note"
              label="Your notes"
              rows={9}
              value={notes}
              onChange={(v) => tele().setNote(p.id, v)}
              placeholder="What you saw, what you advised…"
              hint="Over video you cannot touch, listen to the chest, or take a blood pressure. Write down what you could not check, too."
            />
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={ending}
        title={`End the call with ${first}?`}
        consequence={`${capturing ? 'The recording stops and is saved. ' : ''}You leave the video room. Your notes are kept, and you mark the visit done when they are finished.`}
        confirmLabel="End call"
        tone="destructive"
        onConfirm={() => void endCall(true)}
        onCancel={() => setEnding(false)}
      />
    </ScreenFrame>
  )
}
