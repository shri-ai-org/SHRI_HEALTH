/**
 * S-18-11 · Telestroke session — `/stroke/case/:id/telestroke` (`src/screens/
 * m18/S1811.tsx`): "Video, imaging and the NIHSS on one surface."
 *
 * ARC-22 puts video in the work and the live transcript plus the drafted note
 * beside it. The reason the three are on one surface is practical: a
 * neurologist who has to switch windows to see the CT loses the examination.
 * The imaging panel is one line and a link to the screen that owns the read,
 * not a second copy of the findings; recording is visible to everyone on the
 * call, always.
 *
 * Where the old screen fell short: the transcript and the extracted NIHSS were
 * the index case's (Mr Malhotra, NIHSS 14) on every case, and the spoke
 * physician was always Dr. Priya Menon. Here the transcript and the AI-112
 * extraction show only on the case they were spoken on, and the spoke is the
 * physician who activated the case. Links to screens the persona cannot open
 * are absent (GP-02).
 */

import { Activity, MonitorSmartphone, Mic, MicOff, PhoneOff, Scan, Syringe, User, Video, VideoOff, WifiLow } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient, staff } from '@/data/kit'
import { NIHSS_TOTAL, type StrokeCase } from '@/data/stroke'
import { triageSummary } from '@/data/strokeai'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock } from '../logic/caseClock'
import { isIndexCase, useStrokeCaseParam } from '../logic/strokeCase'
import { useAiActive } from '../state/ai'
import { SuggestionCard } from '../ui/ai'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

import { CaseClockStrip } from './CaseClockStrip'
import { NoCase } from './NotLvo'

/** The index case's examination, as it was spoken. Seconds into the session. */
const TRANSCRIPT = [
  { at: 12, who: 'Hub', text: 'Dr. Menon, I can see you. Can you turn the camera to the patient?' },
  { at: 24, who: 'Spoke', text: 'One moment. There — can you see his face?' },
  { at: 38, who: 'Hub', text: 'Yes. Mr Malhotra, can you smile for me? Good. Now show me your teeth.' },
  { at: 56, who: 'Hub', text: 'Right lower facial weakness. Now both arms out in front of you, palms up.' },
  { at: 74, who: 'Hub', text: 'Right arm drops immediately, no effort against gravity. That is a three.' },
  { at: 96, who: 'Hub', text: 'Mr Malhotra, what is this object? Can you name it for me?' },
  { at: 112, who: 'Spoke', text: 'He is trying but not getting the word out.' },
  { at: 124, who: 'Hub', text: 'Expressive aphasia. That is a two on language. Total is fourteen.' },
]

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

export function TelestrokePage() {
  const { id, strokeCase: c } = useStrokeCaseParam()
  if (!c) return <NoCase screenId="S-18-11" id={id} />
  return <Session key={c.id} c={c} />
}

function Session({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const caseNow = useCaseClock()
  const toast = useUI((s) => s.toast)
  const [elapsed, setElapsed] = useState(0)
  const [notes, setNotes] = useState('')
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [ending, setEnding] = useState(false)

  useEffect(() => {
    const t = window.setInterval(() => setElapsed((e) => Math.min(e + 2, 130)), 300)
    return () => window.clearInterval(t)
  }, [])

  const p = patient(c.patientId)
  const hub = staff('SD-S-02')
  // The spoke on the call is whoever activated this case.
  const spoke = c.activatedBy
  const own = isIndexCase(c)
  const heard = own ? TRANSCRIPT.filter((l) => l.at <= elapsed) : []
  const summary = triageSummary(c)
  const to = {
    nihss: `/stroke/case/${c.id}/nihss`,
    imaging: `/stroke/case/${c.id}/imaging`,
    decision: `/stroke/case/${c.id}/thrombolysis`,
  }

  return (
    <ScreenFrame
      screenId="S-18-11"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Telestroke session"
      sub={`${hub.name} at the hub · ${spoke} at ${c.originFacility}`}
      chips={
        <>
          <PillTag tone="norm" size="sm" icon={Video}>
            in session · <span className="tabular-nums">{mmss(elapsed)}</span>
          </PillTag>
          <PillTag tone="warn" size="sm" icon={WifiLow}>
            bandwidth 640 kbps
          </PillTag>
        </>
      }
      actions={
        <>
          {may(to.nihss) && (
            <Pill variant="card" size="xl" icon={Activity} iconSize={17} onClick={() => navigate(to.nihss)}>
              NIHSS
            </Pill>
          )}
          {may(to.imaging) && (
            <Pill variant="card" size="xl" icon={Scan} iconSize={17} onClick={() => navigate(to.imaging)}>
              Imaging
            </Pill>
          )}
        </>
      }
      actionBar={
        <>
          <Pill variant="crit" size="bar" icon={PhoneOff} onClick={() => setEnding(true)}>
            End the session
          </Pill>
          <span className="text-[13px] text-sh-text-3">Recorded with consent · the session note is drafted from the transcript</span>
          {may(to.decision) && (
            <Pill variant="primary" size="bar" icon={Syringe} className="ml-auto" onClick={() => navigate(to.decision)}>
              Go to the decision
            </Pill>
          )}
        </>
      }
    >
      <div className="grid gap-[20px] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* The examination itself. */}
        <div className="flex min-w-0 flex-col gap-[16px]">
          <Card className="overflow-hidden p-0">
            {/* Video is read on black in both themes, like a scan. */}
            <div className="relative aspect-video w-full bg-(--video-bg)">
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <span className="mx-auto flex size-[64px] items-center justify-center rounded-full bg-(--video-avatar) text-(--video-icon)">
                    <Icon icon={User} size={30} />
                  </span>
                  <p className="mt-[8px] text-[13px] text-(--video-name)">
                    {p.name} · bedside camera at {c.originFacility}
                  </p>
                </div>
              </div>
              {/* The spoke physician, picture-in-picture. */}
              <div className="absolute bottom-[12px] right-[12px] flex size-[96px] flex-col items-center justify-center rounded-[16px] bg-(--video-tile) text-center">
                <Icon icon={cameraOff ? VideoOff : User} size={18} className="text-(--video-icon)" />
                <p className="mt-[4px] px-[4px] text-[10px]/tight text-(--video-name)">{spoke}</p>
              </div>
              {/* Recording is visible to everyone on the call, always. */}
              <div className="absolute left-[12px] top-[12px] flex items-center gap-[8px] rounded-full bg-(--video-tile) px-[10px] py-[4px]">
                <span className="size-[8px] rounded-full bg-sh-crit" aria-hidden="true" />
                <span className="text-[12px] font-semibold text-(--on-image-ink)">RECORDING · with consent</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-[8px] px-[16px] py-[12px]">
              <Pill variant={muted ? 'primary' : 'control'} size="lg" icon={muted ? MicOff : Mic} aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
                {muted ? 'Unmute' : 'Mute'}
              </Pill>
              <Pill variant={cameraOff ? 'primary' : 'control'} size="lg" icon={cameraOff ? VideoOff : Video} aria-pressed={cameraOff} onClick={() => setCameraOff((v) => !v)}>
                {cameraOff ? 'Camera off' : 'Camera'}
              </Pill>
              <Pill variant="control" size="lg" icon={MonitorSmartphone} onClick={() => toast({ tone: 'info', title: 'CT shared to the call', detail: `${spoke} now sees the same slice you do.` })}>
                Share the CT
              </Pill>
            </div>
          </Card>

          {aiActive && summary.length > 0 && (
            <Card
              titleSize="sm"
              title="Imaging"
              right={
                may(to.imaging) ? (
                  <Pill variant="control" size="md" onClick={() => navigate(to.imaging)}>
                    Open the read
                  </Pill>
                ) : undefined
              }
            >
              <p className="text-[14px]">
                {summary.map((f, i) => (
                  <span key={f.label}>
                    {i > 0 && <span className="text-sh-text-3"> · </span>}
                    <span className="text-sh-text-3">{f.label} </span>
                    <span className={cn('font-semibold tabular-nums', f.emphasisNegative && 'text-sh-norm-fg')}>{f.value}</span>
                  </span>
                ))}
              </p>
              <Why label="Why the scan sits beside the examination" className="mt-[8px]">
                <p>
                  Shown here so the examination and the scan are read together. Confirming the finding still happens on the imaging screen, under its own G3 gate — this line is a
                  reminder, not the read.
                </p>
              </Why>
            </Card>
          )}
        </div>

        {/* The live transcript and the drafted note. */}
        <div className="flex min-w-0 flex-col gap-[16px]">
          <Card titleSize="sm" title="Live transcript" right={<span className="text-[12px] text-sh-text-3">speech to text</span>}>
            <div aria-live="polite" className="flex max-h-[288px] flex-col gap-[10px] overflow-y-auto">
              {heard.length === 0 && <p className="py-[24px] text-center text-[14px] text-sh-text-3">Waiting for speech…</p>}
              {heard.map((l) => (
                <div key={l.at} className="flex gap-[10px]">
                  <span className="w-[36px] shrink-0 pt-[2px] text-[12px] tabular-nums text-sh-text-3">{mmss(l.at)}</span>
                  <span className="min-w-0 flex-1 text-[14px] text-sh-text">
                    <span className={cn('mr-[6px] text-[12px] font-semibold', l.who === 'Hub' ? 'text-sh-pend-fg' : 'text-sh-text-3')}>{l.who}</span>
                    {l.text}
                  </span>
                </div>
              ))}
            </div>
            <Why label="What is kept, and what happens if the service drops" className="mt-[8px]">
              <p>The raw transcript is retained verbatim. If the speech service drops, the video continues and this becomes plain typing.</p>
            </Why>
          </Card>

          {aiActive && own && elapsed >= 124 && (
            <SuggestionCard
              touchpointId={`tele:${c.id}:nihss`}
              capabilityId="AI-112"
              title={`NIHSS ${NIHSS_TOTAL} extracted from the examination`}
              evidence="Nine of the fifteen items were scored aloud during the examination and have been extracted. Six were not tested and remain blank rather than zero."
              band="MED"
              score={0.78}
              gate="G2"
              onAccept={() => may(to.nihss) && navigate(to.nihss)}
              explain={{
                touchpointId: `tele:${c.id}:nihss`,
                capabilityId: 'AI-112',
                claim: `A total NIHSS of ${NIHSS_TOTAL} was extracted from what you scored aloud.`,
                confidence: 0.78,
                band: 'MED',
                computedAt: formatTime(caseNow),
                inputs: TRANSCRIPT.filter((l) => l.who === 'Hub')
                  .slice(0, 4)
                  .map((l) => ({ label: l.text, source: `Session transcript at ${mmss(l.at)}` })),
                evidence: ['"Right arm drops immediately, no effort against gravity. That is a three."', '"Expressive aphasia. That is a two on language."'],
                model: 'extract v4.1.0',
                limits: [
                  'Extracts only items you scored aloud. An item examined silently is not captured.',
                  'An untested item stays blank rather than defaulting to zero, because zero means normal.',
                  'Manual scoring is the fallback and the authority.',
                ],
              }}
            />
          )}

          <Card titleSize="sm" title="Your note">
            <VoiceField
              id={`telestroke-note-${c.id}`}
              label="Telestroke note"
              rows={5}
              value={notes}
              onChange={setNotes}
              placeholder="Anything the transcript will not capture — what you saw rather than what was said…"
            />
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={ending}
        title="End the telestroke session?"
        consequence="The call closes for everyone on it. The recording and the transcript are kept with the case; the note you have written stays a draft."
        confirmLabel="End the session"
        tone="destructive"
        onConfirm={() => {
          setEnding(false)
          toast({ tone: 'info', title: 'Session ended', detail: `${Math.floor(elapsed / 60)} min ${String(elapsed % 60).padStart(2, '0')} s · recording kept with case ${c.caseNo}.` })
          navigate(may('/stroke/telestroke/queue') ? '/stroke/telestroke/queue' : '/')
        }}
        onCancel={() => setEnding(false)}
      />
    </ScreenFrame>
  )
}
