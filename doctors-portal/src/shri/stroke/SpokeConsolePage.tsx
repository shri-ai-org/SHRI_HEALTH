/**
 * S-18-13 · Spoke console — `/stroke/spoke` (`src/screens/m18/S1813.tsx`):
 * "Six fields for a general physician who is alone at 02:00."
 *
 * The atlas calls it "THE MOST IMPORTANT DESIGN DECISION IN THE MODULE": a
 * console built for a hub specialist goes unused at a spoke, and an unused
 * spoke console means the network does not exist. So the constraints are the
 * design: six fields, not sixty; one primary action, always enabled, never
 * gated on the AI or the network; targets of 64px and more, usable one-handed
 * while holding a phone; the phone path always on screen; OFFLINE the
 * EXPECTED state, not the exception.
 *
 * Where the old screen fell short: the anticoagulant question listed
 * "Unknown" twice, and the last-known-well time field could not take the
 * "unknown" its own guidance asks for — here each question offers Unknown
 * once. Links to screens the persona cannot open are absent (GP-02).
 */

import { Building2, CircleCheck, Clock, Info, Phone, Scan, Siren, Upload, UserX, Video, WifiLow } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { facility } from '@/data/kit'
import { ACTIVE_CASE } from '@/data/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseNow } from '../logic/caseClock'
import { useAiActive, useForcedState } from '../state/ai'
import { SuggestionCard } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { Field, Select, TextInput } from '../ui/forms'
import { Card, Diamond, Icon, Pill, PillTag } from '../ui/primitives'

/**
 * The six questions that actually change the decision. `help` is never a
 * paragraph — it is the field's title and hint, so the form is six lines
 * rather than six essays.
 */
const SIX = [
  { key: 'lkw', label: 'When was the patient last known well?', help: 'Not when they were found — when they were last definitely normal. If nobody saw it, say unknown.', type: 'time' as const },
  {
    key: 'deficit',
    label: 'What is the deficit?',
    help: 'In your own words. The hub scores the NIHSS over video.',
    type: 'select' as const,
    options: ['Right-sided weakness with speech difficulty', 'Left-sided weakness', 'Speech difficulty only', 'Visual loss', 'Reduced consciousness', 'Other'],
  },
  {
    key: 'anticoag',
    label: 'Is the patient on a blood thinner?',
    help: 'Warfarin, or any of the newer ones. Unknown is an acceptable answer and does not block.',
    type: 'select' as const,
    options: ['No', 'Yes — warfarin', 'Yes — a newer anticoagulant (DOAC)', 'Unknown'],
  },
  { key: 'bp', label: 'Blood pressure now', help: 'Systolic over diastolic. Above 185/110 needs treating before thrombolysis.', placeholder: 'e.g. 196/104', type: 'text' as const },
  { key: 'glucose', label: 'Capillary glucose', help: 'Hypoglycaemia mimics a stroke. This is the one test that changes the diagnosis.', placeholder: 'e.g. 7.2 mmol/L', type: 'text' as const },
  { key: 'weight', label: 'Weight, measured or estimated', help: 'The thrombolytic dose is per kilogram, so an estimate is better than a blank.', placeholder: 'kg — an estimate beats a blank', type: 'text' as const },
]

/** The spoke this console serves — Pollachi, a general physician and no neurologist. */
const SITE = facility('IPL')
const HUB = facility('ISH')

export function SpokeConsolePage() {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const caseNow = useCaseNow()

  const [activated, setActivated] = useState(false)
  const [calling, setCalling] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [ctProgress, setCtProgress] = useState(0)
  const upload = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearInterval(upload.current), [])

  const offline = forced === 'OFFLINE'
  const answered = SIX.filter((f) => (answers[f.key] ?? '').trim()).length
  const mimicCard = aiActive && activated
  const set = (key: string, value: string) => setAnswers((a) => ({ ...a, [key]: value }))
  const to = { session: `/stroke/case/${ACTIVE_CASE.id}/telestroke`, clock: `/stroke/case/${ACTIVE_CASE.id}/clock`, imaging: `/stroke/case/${ACTIVE_CASE.id}/imaging` }

  function uploadCt() {
    setCtProgress(1)
    upload.current = window.setInterval(() => {
      setCtProgress((v) => {
        if (v >= 100) {
          window.clearInterval(upload.current)
          return 100
        }
        return v + 7
      })
    }, 260)
  }

  const big = 'h-[64px] text-[16px]'

  return (
    <ScreenFrame
      screenId="S-18-13"
      heading="Spoke console"
      sub={activated ? `STROKE/26-27/${ACTIVE_CASE.id} · clock running · ${answered} of ${SIX.length} answered` : 'No case activated · one tap starts the clock and pages the hub'}
      chips={
        <>
          <PillTag tone="pend" size="sm" icon={Building2}>
            {SITE.code} · {SITE.role}
          </PillTag>
          <PillTag tone="warn" size="sm" icon={UserX}>
            no on-site neurologist
          </PillTag>
          <PillTag tone="neu" size="sm" icon={Clock}>
            <span className="tabular-nums">{formatTime(caseNow)}</span>
          </PillTag>
        </>
      }
      actions={
        /* The phone is always a path. Never remove it. */
        <Pill variant="card" size="xl" icon={Phone} iconSize={17} className="h-[56px]" onClick={() => setCalling(true)}>
          Call the hub
        </Pill>
      }
      railTitle="At a spoke"
      railBadge={mimicCard ? 1 : undefined}
      rail={
        <div className="flex flex-col gap-[12px]">
          {mimicCard && (
            <SuggestionCard
              touchpointId="spoke:mimic"
              capabilityId="AI-203"
              title="Consider a stroke mimic"
              evidence="Check the capillary glucose before anything else — hypoglycaemia is the commonest mimic and is immediately reversible. Seizure with a post-ictal deficit is the second."
              band="MED"
              score={0.66}
              gate="G1"
              caution="Advisory. It suggests, never concludes, and it does not delay activation."
              explain={{
                touchpointId: 'spoke:mimic',
                capabilityId: 'AI-203',
                claim: 'A stroke mimic is worth excluding before committing to the pathway.',
                confidence: 0.66,
                band: 'MED',
                computedAt: formatTime(caseNow),
                inputs: [
                  { label: 'Presenting deficit as described', source: 'This form' },
                  { label: 'Site mimic rate', source: 'Stroke registry, IPL' },
                ],
                evidence: ['One of three activations at this site last month was a mimic.', 'Glucose is the single test with the highest yield here.'],
                model: 'ddx v2.6.1',
                limits: ['Advisory only. It never de-activates a case and never delays activation.', 'It cannot examine the patient.', 'Your own judgement is the fallback and the authority.'],
              }}
            />
          )}
          <Why label="Why six questions, and what happens if the network drops">
            <p>
              The hub needs sixty things. You need six. Everything else is collected at the hub from what you send and from the video call, because a console that asks a lone
              physician sixty questions at 02:00 gets closed.
            </p>
            <p>Activation and all six answers capture locally and queue. The phone number stays on screen. The printed protocol cards stay available. Nothing you have typed is lost.</p>
            <p className="text-sh-text-3">Offline is the expected state here, not an error.</p>
          </Why>
        </div>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {offline && (
          <Alert tone="warn" title="No connection — this is the expected state here">
            Activation and your answers are captured locally and will send when the link returns. Call the hub now on the number above; the phone path does not depend on this
            screen.
          </Alert>
        )}

        {/* One primary action, the largest target, always enabled. */}
        {!activated ? (
          <Card className="items-center px-[24px] py-[32px] text-center md:py-[48px]">
            <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-sh-text md:text-[26px]">Suspected stroke?</h2>
            <p className="mx-auto mt-[8px] max-w-[512px] text-[15px] text-sh-text-2">
              One action starts the clock and raises the telestroke request together — always enabled, never gated on the model, the network, or a complete form.
            </p>
            <button
              type="button"
              onClick={() => {
                setActivated(true)
                toast({ tone: 'critical', title: 'Code stroke activated', detail: 'The clock has started and the hub has been paged. Dr. Rajsrinivas is on call.' })
              }}
              className="mx-auto mt-[24px] flex min-h-[80px] w-full max-w-[448px] items-center justify-center gap-[12px] rounded-sh-card bg-sh-crit-solid px-[32px] text-[18px] font-bold text-sh-on-crit-solid shadow-sh-pop transition-[filter] duration-150 hover:brightness-110 active:scale-[0.99] md:text-[20px]"
            >
              <Icon icon={Siren} size={26} />
              ACTIVATE &amp; REQUEST HUB
            </button>
          </Card>
        ) : (
          <>
            <Alert tone="info" icon={CircleCheck} title="Activated — the clock is running and the hub is paged">
              STROKE/26-27/{ACTIVE_CASE.id} · Dr. Rajsrinivas has acknowledged. Answer the six questions below while you wait for the video call; each one saves as you go.
            </Alert>

            {(may(to.session) || may(to.clock)) && (
              <div className="grid gap-[16px] md:grid-cols-2">
                {may(to.session) && (
                  <Pill variant="primary" size="xl" icon={Video} className="h-[64px] text-[16px]" onClick={() => navigate(to.session)}>
                    Join the video call
                  </Pill>
                )}
                {may(to.clock) && (
                  <Pill variant="card" size="xl" icon={Clock} className="h-[64px] text-[16px]" onClick={() => navigate(to.clock)}>
                    See the case clock
                  </Pill>
                )}
              </div>
            )}

            {/* The six. One field per row, every target at least 64px. */}
            <Card titleSize="sm" title="The six questions" right={<span className="text-[13px] text-sh-text-3">none of them blocks</span>}>
              <div className="flex flex-col gap-[20px]">
                {SIX.map((f, i) => {
                  const value = answers[f.key] ?? ''
                  const unknown = value === 'Unknown'
                  return (
                    <div key={f.key} className="min-w-0">
                      <Field label={`${i + 1}. ${f.label}`} htmlFor={`six-${f.key}`} hint={f.help}>
                        {f.type === 'select' ? (
                          <Select id={`six-${f.key}`} title={f.help} value={value} onChange={(e) => set(f.key, e.target.value)} className={big}>
                            <option value="">Choose, or leave blank…</option>
                            {f.options.map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                            {/* Unknown, once — the anticoagulant list already carries it. */}
                            {!f.options.includes('Unknown') && <option value="Unknown">Unknown</option>}
                          </Select>
                        ) : f.type === 'time' ? (
                          <div className="flex flex-wrap items-center gap-[8px]">
                            <TextInput id={`six-${f.key}`} type="time" title={f.help} value={unknown ? '' : value} disabled={unknown} onChange={(e) => set(f.key, e.target.value)} className={cn(big, 'w-auto min-w-[200px] flex-1')} />
                            <Pill variant={unknown ? 'primary' : 'control'} size="xl" aria-pressed={unknown} className="h-[64px]" onClick={() => set(f.key, unknown ? '' : 'Unknown')}>
                              Unknown
                            </Pill>
                          </div>
                        ) : (
                          <TextInput id={`six-${f.key}`} type="text" title={f.help} value={value} onChange={(e) => set(f.key, e.target.value)} className={big} placeholder={f.placeholder} />
                        )}
                      </Field>
                      {unknown && (
                        <p className="mt-[8px] flex items-start gap-[8px] rounded-[12px] bg-sh-warn-bg px-[12px] py-[8px] text-[14px] font-medium text-sh-warn-fg">
                          <Icon icon={Info} size={14} className="mt-[3px] shrink-0" />
                          Unknown is recorded as unknown, and the hub sees it as unknown. It is not treated as a no.
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </Card>

            {/* Poor bandwidth: the CT uploads progressively while the clock runs. */}
            <Card
              titleSize="sm"
              title="Upload the CT"
              right={
                <PillTag tone="warn" size="sm" icon={WifiLow}>
                  bandwidth is poor here
                </PillTag>
              }
            >
              <p className="text-[14px] text-sh-text-2">It uploads progressively — the hub reads a low-resolution series before the full study arrives.</p>
              {ctProgress === 0 ? (
                <Pill variant="primary" size="xl" icon={Upload} className="mt-[16px] h-[64px] w-full text-[16px]" onClick={uploadCt}>
                  Upload the NCCT
                </Pill>
              ) : (
                <div className="mt-[16px]">
                  <div className="flex items-baseline justify-between gap-[8px]">
                    <span className="text-[14px] font-medium text-sh-text">{ctProgress >= 100 ? 'Uploaded — full resolution' : 'Uploading'}</span>
                    <span className="font-semibold tabular-nums text-sh-text">{Math.min(100, ctProgress)}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="NCCT upload"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, ctProgress)}
                    className="mt-[8px] h-[12px] overflow-hidden rounded-full bg-sh-inner"
                  >
                    <div className={cn('h-full rounded-full transition-[width] duration-200', ctProgress >= 100 ? 'bg-sh-norm' : 'bg-sh-pend')} style={{ width: `${Math.min(100, ctProgress)}%` }} />
                  </div>
                  <p className="mt-[8px] text-[14px] text-sh-text-2">
                    {ctProgress >= 35 && ctProgress < 100
                      ? 'Low-resolution series is already with the hub. They can start reading.'
                      : ctProgress >= 100
                        ? 'The hub has the full study.'
                        : 'Sending the first series…'}
                  </p>
                  {ctProgress >= 60 && aiActive && may(to.imaging) && (
                    <Pill variant="accent" size="xl" icon={Scan} className="mt-[12px] h-[64px] w-full text-[16px]" onClick={() => navigate(to.imaging)}>
                      <Diamond />
                      The AI has read it — see the triage card
                    </Pill>
                  )}
                </div>
              )}
            </Card>
          </>
        )}
      </div>

      <ConfirmDialog
        open={calling}
        title={`Call the stroke hub at ${HUB.name}?`}
        consequence="Rings the on-call stroke neurologist, Dr. Rajsrinivas, on the hub's stroke line. The call is logged against this case with the time."
        confirmLabel="Call now"
        onConfirm={() => {
          setCalling(false)
          toast({ tone: 'info', title: 'Calling Dr. Rajsrinivas', detail: `Hub stroke line · logged against the case at ${formatTime(caseNow)}.` })
        }}
        onCancel={() => setCalling(false)}
      />
    </ScreenFrame>
  )
}
