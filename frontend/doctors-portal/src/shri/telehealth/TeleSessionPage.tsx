/**
 * S-27-03 · Video visit — `/tele/session/:id`. Keyed by a teleconsult from the
 * Video visits list, or a patient (SD id or UHID) from their record; an unknown
 * id says so.
 *
 * One page, three moments, in plain words, always in two columns:
 *   left   before the call: one button and the patient's recording consent (VisitSetup);
 *          in the call: the video, the patient large and the doctor small (CallVideo),
 *          under the call bar across the top (CallBar);
 *          after the call: the downloads and Mark visit as done (AfterVisit);
 *          and under each, the doctor's notes and the conversation as it was said.
 *   right  the patient's record — history, results, scans, vitals, trend, earlier
 *          notes — and the prescription (VisitRecord), read while the patient talks.
 * The left column stays in view while the record scrolls.
 *
 * The notes are a draft, typed or spoken (typing goes on while the mic listens),
 * until the doctor saves them to the record as a signed consultation note.
 *
 * The video is the visit's own Jitsi room, made with the booking, so the patient
 * can be waiting in it first: then the doctor is told on every screen, and Connect
 * (WaitingBar) arrives here with the call already started. The call is the
 * consultation, so there is no Start consultation here.
 *
 * The recording and the conversation are this page's (capture.ts), kept on the
 * server where one is set up (teleStore.ts).
 */

import { Save } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { useAudit } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useVoiceNotesFor } from '../logic/record'
import { TYPED_MODEL } from '../logic/speech'
import { teleParty } from '../logic/tele'
import { useOpd } from '../state/opd'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Card, Pill } from '../ui/primitives'
import { VoiceField, type DictatedMeta } from '../ui/VoiceField'

import { AfterVisit } from './AfterVisit'
import { stopCapture } from './capture'
import { Conversation } from './Conversation'
import { CallBar, CallVideo } from './InCall'
import { newRoomName, roomUrl } from './jitsi'
import { NoParty } from './NoParty'
import type { RecordHeader } from './visitRecord'
import { VisitRecord } from './VisitRecord'
import { demoCode } from './demoCode'
import { roomOfVisit, visitFor } from './visits'
import { consentOf, useTele } from './teleStore'
import { STATUS_CLASS, STATUS_WORD, useVisitStatus } from './visitStatus'
import { VisitSetup } from './VisitSetup'
import { useWaiting } from './waitingRoom'

export function TeleSessionPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useUI((s) => s.toast)
  const me = useCurrentStaff()
  const record = useAudit((s) => s.record)
  const saveVoiceNote = useClinical((s) => s.saveVoiceNote)
  const signVoiceNote = useClinical((s) => s.signVoiceNote)
  const leaveWaiting = useWaiting((s) => s.leave)
  const [ending, setEnding] = useState(false)
  const [newCall, setNewCall] = useState(false)
  const [others, setOthers] = useState(0)
  const videoBox = useRef<HTMLDivElement>(null)
  /** The last dictation into the notes — its engine goes on the saved note. */
  const dictated = useRef<DictatedMeta | null>(null)
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
  const savedIds = useTele((s) => s.saved[pid])
  const consent = useTele((s) => consentOf(s, pid))
  const recordNotes = useVoiceNotesFor(pid)
  const statusOf = useVisitStatus()

  async function start() {
    if (!party) return
    const { patient: p, encounter: enc } = party
    const booking = visitFor(p.id)
    const other = tele().activeSid
    if (other) {
      await stopCapture()
      tele().end(other)
    }
    // The visit's own room, made with the booking; the patient portal takes the patient into the same one.
    const room = booking ? roomOfVisit(booking.id, demoCode()) : newRoomName(p.id)
    tele().begin({ patientId: p.id, encounterId: enc?.id, meetUri: roomUrl(room), meetCode: room, consent: consentOf(tele(), p.id) ?? 'declined' })
    if (booking) leaveWaiting(booking.id)
    setNewCall(false)
    startOpd(p.id)
  }

  // Connect, from the waiting alert: the call starts as the page opens.
  const joinAsked = (location.state as { join?: boolean } | null)?.join === true
  const joined = useRef(false)
  useEffect(() => {
    if (!joinAsked) {
      joined.current = false
      return
    }
    if (joined.current || !party) return
    joined.current = true
    navigate(location.pathname, { replace: true, state: null })
    if (!activeSid) void start()
    else {
      // Already in this patient's call: they are no longer waiting.
      const booking = visitFor(party.patient.id)
      if (booking) leaveWaiting(booking.id)
    }
    // Once, on arriving with the ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinAsked])

  if (!party) return <NoParty screenId="S-27-03" id={id} />
  const { patient: p, encounter: enc } = party
  const first = p.name.split(' ')[0] || p.name
  const booking = visitFor(p.id)
  const status = statusOf(p.id)
  const mode = activeSid ? 'call' : shown && !newCall ? 'after' : 'setup'
  const draft = notes.trim()
  // The notes saved from this patient's video visits, oldest first, then the draft — what the visit record carries.
  const saved = recordNotes.filter((n) => savedIds?.includes(n.id)).reverse()
  const noteForRecord = [...saved.map((n) => n.body), draft].filter(Boolean).join('\n\n')

  const header: RecordHeader | undefined = shown && {
    patient: p.name,
    uhid: p.uhid,
    doctor: me?.name,
    startedAt: shown.startedAt,
    endedAt: shown.endedAt,
    meetUri: shown.meetUri,
    consent: shown.consent === 'given' ? 'given by the patient, in the patient portal' : 'not given',
  }

  async function endCall(asked: boolean) {
    setEnding(false)
    const sid = activeSid
    await stopCapture()
    if (sid) tele().end(sid)
    setOthers(0)
    toast({ tone: 'success', title: 'Call ended', detail: asked ? 'Finish your notes, then mark the visit done.' : `You left the video. Finish your notes, then mark the visit done.` })
  }

  /** The draft becomes a signed consultation note in the record, as the record's own notes are. */
  function saveNotes() {
    if (!draft || !me) return
    const meta = dictated.current
    const model = meta?.model ?? TYPED_MODEL
    const words = draft.split(/\s+/).length
    const noteId = saveVoiceNote({ patientId: p.id, body: draft, by: me.name, model, band: meta?.band ?? 'HIGH' })
    signVoiceNote(p.id, noteId, me.name)
    record({ event: 'NOTE.DRAFT_SAVED', actor: me.name, actorId: me.id, subject: p.id, model, gate: 'G2', detail: `Video visit note saved, ${meta ? 'typed and dictated' : 'typed'} · ${words} words` })
    record({ event: 'NOTE.SIGNED', actor: me.name, actorId: me.id, subject: p.id, model, detail: `Video visit note signed · ${words} words` })
    tele().addSaved(p.id, noteId)
    tele().setNote(p.id, '')
    dictated.current = null
    toast({ tone: 'success', title: 'Note saved to the record', detail: `${p.name} · signed, under Consultation notes` })
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
      <div className="flex flex-col gap-[16px]">
        {mode === 'call' && activeSid && shown && (
          <CallBar sid={activeSid} patientId={p.id} firstName={first} startedAt={shown.startedAt} others={others} videoBox={videoBox} onEnd={() => setEnding(true)} />
        )}

        <div className="grid items-start gap-[16px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          {/* The call and the notes: in view while the record scrolls. */}
          <div className="sh-scrollbar flex min-w-0 flex-col gap-[16px] lg:sticky lg:top-[12px] lg:max-h-[calc(100dvh-24px)] lg:overflow-y-auto [&>*]:shrink-0" data-visit-call="">
            {mode === 'setup' && <VisitSetup firstName={first} consent={consent} onStart={() => void start()} />}
            {mode === 'call' && activeSid && shown && (
              <CallVideo
                sid={activeSid}
                patientId={p.id}
                firstName={first}
                room={shown.meetCode ?? newRoomName(shown.id)}
                doctorName={me?.name ?? 'Doctor'}
                videoBox={videoBox}
                onOthers={(n) => {
                  setOthers(n)
                  // The patient is in the call with the doctor: no longer waiting.
                  if (n > 0 && booking) leaveWaiting(booking.id)
                }}
                onLeftRoom={() => void endCall(false)}
              />
            )}
            {mode === 'after' && shown && header && (
              <AfterVisit
                sid={shown.id}
                header={header}
                note={noteForRecord}
                firstName={first}
                done={status === 'done'}
                unsaved={draft !== ''}
                onDone={() => {
                  tele().markDone(p.id)
                  finishOpd(p.id)
                  toast({ tone: 'success', title: 'Visit done', detail: `${p.name}’s video visit is finished.` })
                }}
                onReopen={() => tele().reopen(p.id)}
                onNewCall={() => setNewCall(true)}
              />
            )}

            <Card titleSize="sm" title="Your notes">
              <VoiceField
                id="tele-note"
                layout="note"
                typeAlong
                label="Your notes"
                rows={7}
                value={notes}
                onChange={(v) => tele().setNote(p.id, v)}
                onDictated={(m) => (dictated.current = m)}
                placeholder="What you saw, what you advised…"
                hint="Over video you cannot touch, listen to the chest, or take a blood pressure. Write down what you could not check, too."
              />
              <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
                <Pill variant="primary" size="lg" icon={Save} disabled={!draft} onClick={saveNotes}>
                  Save to record
                </Pill>
                <span className="min-w-[180px] flex-1 text-[13px] text-sh-text-3" data-note-state={draft ? 'draft' : saved.length ? 'saved' : 'empty'}>
                  {draft
                    ? 'This is a draft until you save it. You can change anything first, by typing or speaking.'
                    : saved.length
                      ? `${saved.length === 1 ? 'One note' : `${saved.length} notes`} saved to ${first}’s record from this visit, signed, under Consultation notes.`
                      : 'Type or speak your notes. They stay a draft until you save them to the record.'}
                </span>
              </div>
            </Card>

            {mode === 'call' && activeSid && consent === 'given' && header && <Conversation sid={activeSid} firstName={first} header={header} editableBy={me?.name} />}
            {mode === 'after' && shown && header && shown.segments.length > 0 && (
              <Conversation sid={shown.id} firstName={first} header={header} editableBy={status === 'done' ? undefined : me?.name} />
            )}
          </div>

          <VisitRecord patient={p} booking={booking} encounterId={enc?.id} />
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
