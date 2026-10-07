/**
 * S-27-03 · Teleconsult session — `/tele/session/:id` (`src/screens/m27/
 * Telehealth.tsx` S2703): the call, the one note the session ends with, and
 * what a teleconsult cannot do. Keyed by a teleconsult encounter from the
 * queue, or a patient (SD id or UHID) from the record's Connect; an unknown id
 * says so. The call is joined on purpose, never on arrival; ending it is
 * confirmed, because it closes the call for the patient too.
 */

import { Check, FileText, Image, Mic, MicOff, Phone, PhoneOff, Pill as PillIcon, User, Video, VideoOff, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { NOW, formatTime } from '@/data/format'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { consultPath, noteActionLabel } from '../logic/record'
import { teleParty } from '../logic/tele'
import { useAiActive } from '../state/ai'
import { useOpd } from '../state/opd'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { KeyValue } from '../ui/KeyValue'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

import { NoParty } from './NoParty'

const CANNOT = ['Palpate, percuss or auscultate', 'Take a blood pressure or a temperature you can trust', 'Assess a rash for texture, only for appearance', 'Prescribe from the prohibited category list']

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

export function TeleSessionPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const aiActive = useAiActive()
  const toast = useUI((s) => s.toast)
  const [elapsed, setElapsed] = useState(0)
  const [notes, setNotes] = useState('')
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [ending, setEnding] = useState(false)
  const [joined, setJoined] = useState(false)
  // Joining puts the patient in the room on every OPD card; ending the session makes them Seen.
  const startOpd = useOpd((s) => s.start)
  const finishOpd = useOpd((s) => s.finish)

  useEffect(() => {
    if (!joined) return
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => window.clearInterval(t)
  }, [joined])

  const party = teleParty(id)
  if (!party) return <NoParty screenId="S-27-03" id={id} />
  const { patient: p, encounter: enc } = party
  const notePath = consultPath(p)

  return (
    <ScreenFrame
      screenId="S-27-03"
      patient={p}
      chips={
        joined ? (
          <PillTag tone="norm" size="sm" icon={Video}>
            in session · <span className="tabular-nums">{clock(elapsed)}</span>
          </PillTag>
        ) : (
          <PillTag tone="neu" size="sm" icon={Video}>
            Waiting
          </PillTag>
        )
      }
      actionBar={
        <>
          {joined ? (
            <Pill variant="crit" size="bar" icon={PhoneOff} onClick={() => setEnding(true)}>
              End the session
            </Pill>
          ) : (
            <span className="text-[13px] text-sh-text-3">Join the call to start the session</span>
          )}
          {enc && (
            <div className="ml-auto flex flex-wrap gap-[8px]">
              {notePath && (
                <Pill variant="control" size="bar" icon={FileText} onClick={() => navigate(notePath)}>
                  {noteActionLabel(p)}
                </Pill>
              )}
              <Pill variant="primary" size="bar" icon={PillIcon} onClick={() => navigate(`/tele/session/${enc.id}/rx`)}>
                Prescribe
              </Pill>
            </div>
          )}
        </>
      }
      rail={
        <div className="flex flex-col gap-[12px]">
          <Card titleSize="sm" title="Consent">
            <dl className="flex flex-col divide-y divide-sh-line">
              <KeyValue label="Teleconsult">
                <PillTag tone="norm" size="sm" icon={Check}>
                  taken
                </PillTag>
              </KeyValue>
              <KeyValue label="Recording">
                <PillTag tone="neu" size="sm" icon={X}>
                  declined
                </PillTag>
              </KeyValue>
              <KeyValue label="Language">English</KeyValue>
            </dl>
            <p className="mt-[8px] text-[12px] text-sh-text-3">The patient declined recording, so the transcript is not retained after the session. The note is.</p>
          </Card>
          <Why label="What a teleconsult cannot do">
            <ul className="flex flex-col gap-[8px]">
              {CANNOT.map((t) => (
                <li key={t} className="flex gap-[8px]">
                  <Icon icon={X} size={13} className="mt-[3px] text-sh-warn-fg" />
                  {t}
                </li>
              ))}
            </ul>
            <p className="text-sh-text-3">
              The last one is enforced by the prescription screen. The first three are yours to remember, and the note should say what you could not assess.
              {aiActive && ' AI-101, the same ambient scribe as a face-to-face consultation, lands on the same note surface — off for this session because recording was declined.'}
            </p>
          </Why>
        </div>
      }
      railTitle="Session"
    >
      <div className="grid gap-[16px] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden p-0">
          {/* Video is read on black in both themes, like a scan. */}
          <div className="relative aspect-video w-full bg-(--video-bg)">
            {joined ? (
              <>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <span className="mx-auto flex size-[64px] items-center justify-center rounded-full bg-(--video-avatar) text-(--video-icon)">
                      <Icon icon={User} size={30} />
                    </span>
                    <p className="mt-[8px] text-[13px] text-(--video-name)">{p.name}</p>
                  </div>
                </div>
                <div className="absolute bottom-[12px] right-[12px] flex size-[96px] items-center justify-center rounded-[16px] bg-(--video-tile)">
                  <Icon icon={cameraOff ? VideoOff : User} size={18} className="text-(--video-icon)" />
                </div>
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-[12px]">
                <p className="text-[13px] text-(--on-image-ink)">{p.name}</p>
                <Pill
                  variant="accent"
                  size="xl"
                  icon={Video}
                  onClick={() => {
                    setJoined(true)
                    startOpd(p.id)
                  }}
                >
                  Join call
                </Pill>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
            <Pill variant={muted ? 'primary' : 'control'} size="lg" icon={muted ? MicOff : Mic} aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
              {muted ? 'Unmute' : 'Mute'}
            </Pill>
            <Pill variant={cameraOff ? 'primary' : 'control'} size="lg" icon={cameraOff ? VideoOff : Video} aria-pressed={cameraOff} onClick={() => setCameraOff((v) => !v)}>
              {cameraOff ? 'Camera off' : 'Camera'}
            </Pill>
            <Pill
              variant="control"
              size="lg"
              icon={Image}
              onClick={() => toast({ tone: 'info', title: 'No photographs uploaded', detail: `${p.name} has not sent any photographs for this teleconsult. Ask them to use the patient app.` })}
            >
              Patient photographs
            </Pill>
            <span className="ml-auto text-[12px] tabular-nums text-sh-text-3">
              <Icon icon={Phone} size={12} className="mr-[4px] inline" />
              {formatTime(NOW)}
            </span>
          </div>
        </Card>

        {/* One note surface — the note the session ends with. */}
        <Card titleSize="sm" title="Your note">
          <VoiceField
            id="tele-note"
            label="Teleconsult note"
            rows={10}
            value={notes}
            onChange={setNotes}
            placeholder="What you observed over video, and what you could not assess…"
            hint="What you could not examine matters as much as what you could. Record both. Dictation uses your microphone only; the teleconsult itself is not recorded."
          />
        </Card>
      </div>

      <ConfirmDialog
        open={ending}
        title="End the teleconsult?"
        consequence="The video call closes for the patient too. Your note stays a draft, and the prescription you have started is kept."
        confirmLabel="End the session"
        tone="destructive"
        onConfirm={() => {
          setEnding(false)
          finishOpd(p.id)
          toast({ tone: 'info', title: 'Teleconsult ended', detail: `${Math.floor(elapsed / 60)} min ${String(elapsed % 60).padStart(2, '0')} s with ${p.name}.` })
          navigate('/tele/queue')
        }}
        onCancel={() => setEnding(false)}
      />
    </ScreenFrame>
  )
}
