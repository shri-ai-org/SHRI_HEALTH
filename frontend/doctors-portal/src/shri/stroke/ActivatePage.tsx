/**
 * S-18-04 · Code stroke — `/stroke/activate` (`src/screens/m18/S1804.tsx`):
 * "One tap that starts everything."
 *
 * AI-209's guardrail is the design constraint: "THE ONE-TAP MANUAL ACTIVATION
 * BUTTON IS ALWAYS PRESENT AND NEVER GATED ON THE MODEL." So the button comes
 * first on the page, works with the AI off, works offline, and needs nothing
 * filled in before it fires. What one tap does, and why the button is never
 * gated, fold behind one line each; after activation the unanswered page is
 * the thing on the surface.
 *
 * AI-209 here is the detection prompt — it reads the triage note already
 * written and describes the present, so it stays (only its projected breach,
 * on the case clock, was a forecast). Where the old screen fell short:
 * activating wrote no record (it is on the audit trail now, queued while
 * offline, with the optional context as it stood), and its next steps went to
 * screens the persona could not open (absent now, GP-02).
 *
 * DEV `?open=activated` lands on the after-activation view, for the walk and
 * the contrast audit; it writes no audit row.
 */

import { Brain, Check, CircleCheck, ClipboardList, Clock, Scan, Siren, Users, Video, Wallet, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { FACILITIES } from '@/data/kit'
import { ACTIVE_CASE, PAGING_LOG } from '@/data/stroke'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { useCaseClock } from '../logic/caseClock'
import { useAiActive, useForcedState } from '../state/ai'
import { devOpens } from '../state/store'
import { Alert } from '../ui/Alert'
import { Disclosure, Why } from '../ui/Disclosure'
import { Field, Select, TextInput } from '../ui/forms'
import { Card, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'

import { AIBanner } from './StrokeBits'

const TRIGGERS: { icon: LucideIcon; label: string; detail: string }[] = [
  { icon: Clock, label: 'The case clock starts', detail: 'Door time is stamped from the server, not from a device.' },
  { icon: Users, label: 'The team is paged', detail: 'Neurologist, coordinator and radiographer, in parallel.' },
  { icon: Scan, label: 'CT is prioritised', detail: 'The scanner queue is reordered; the radiographer is told why.' },
  { icon: Brain, label: 'The case appears on the wall', detail: 'Visible at the hub and on every on-call phone.' },
  { icon: ClipboardList, label: 'The activation order set is offered', detail: 'NCCT, CTA, CTP, bloods, ECG — one action.' },
  { icon: Wallet, label: 'Pre-authorisation starts in parallel', detail: 'Never on the critical path.' },
]

const SOURCES = ['Walk-in to the emergency department', 'Ambulance, pre-notified', 'Ambulance, not pre-notified', 'In-hospital, already admitted', 'Transferred from another site']

type Page = (typeof PAGING_LOG)[number]

export function ActivatePage() {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const forced = useForcedState()
  const caseNow = useCaseClock()

  const [site, setSite] = useState(me.facilityCode)
  const [source, setSource] = useState(SOURCES[0])
  const [lkw, setLkw] = useState('')
  const [activated, setActivated] = useState(() => devOpens('activated'))

  const offline = forced === 'OFFLINE'
  const unanswered = PAGING_LOG.filter((x) => !x.ackAt)
  const answered = PAGING_LOG.filter((x) => x.ackAt)
  const base = `/stroke/case/${ACTIVE_CASE.id}`

  function activate() {
    setActivated(true)
    audit({
      event: 'STROKE.CODE_ACTIVATED',
      actor: me.name,
      actorId: me.id,
      subject: ACTIVE_CASE.patientId,
      at: caseNow.toISOString(),
      detail: `${ACTIVE_CASE.caseNo} · clock started ${formatTime(caseNow)} · ${site} · ${source} · LKW ${lkw || 'unknown'}`,
      ...(offline ? { queued: true } : {}),
    })
    toast({ tone: 'critical', title: 'Code stroke activated', detail: `STROKE/26-27/${ACTIVE_CASE.id} · clock started at ${formatTime(caseNow)} · team paged.` })
  }

  const pageRow = (x: Page) => (
    <li key={x.role} className="flex min-h-[56px] flex-wrap items-center justify-between gap-[8px] px-[4px] py-[8px]">
      <span className="min-w-0">
        <span className="block font-medium">{x.role}</span>
        <span className="block text-[13px] text-sh-text-2">
          {x.name} · {x.channel}
        </span>
      </span>
      {x.ackAt ? (
        <PillTag tone="norm" size="sm" icon={Check}>
          answered {formatTime(x.ackAt)}
        </PillTag>
      ) : (
        <PillTag tone="warn" size="sm" icon={Clock}>
          paged {formatTime(x.pagedAt)} · no answer yet
        </PillTag>
      )}
    </li>
  )

  const next = [
    { to: `${base}/clock`, label: 'Open the case clock', icon: Clock, primary: true },
    { to: `${base}/intake`, label: 'Complete the intake', icon: ClipboardList },
    { to: '/stroke/telestroke/queue', label: 'Telestroke queue', icon: Video },
  ].filter((n) => may(n.to))

  return (
    <ScreenFrame
      screenId="S-18-04"
      heading="Code stroke"
      sub={activated ? `Activated · ${answered.length} of ${PAGING_LOG.length} answered` : `Server time ${formatTime(caseNow)} · one tap, nothing required first`}
      railTitle="Activation"
      rail={
        <Why label="Why the button is never gated, and why de-activating is normal">
          <p>
            A detection model that is down, a network that has dropped, or a form that is half-filled must not be able to stop a code stroke. So activation is a manual, always-enabled action, and everything else on this page is optional context. The manual path is the product, not the fallback.
          </p>
          <p>One in three activations at a spoke turns out to be a mimic. De-activation keeps the record and its reason — a network that only shows true strokes is not being honest about its own performance.</p>
        </Why>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {offline && (
          <Alert tone="warn" title="No connection — activation still works">
            The activation and the clock capture locally and queue. The paging goes out over the phone rota instead.
          </Alert>
        )}

        {aiActive && !activated && (
          <AIBanner
            capabilityId="AI-209"
            title="A possible stroke has been detected from the triage note"
            detail="Sudden right-sided weakness with speech difficulty, onset within the window. This is a prompt — it does not activate anything."
            explain={{
              touchpointId: 'stroke:detect',
              capabilityId: 'AI-209',
              claim: 'The triage entry describes a presentation consistent with an acute stroke.',
              confidence: 0.83,
              band: 'HIGH',
              computedAt: formatTime(caseNow),
              inputs: [
                { label: 'ED triage free text', source: 'Triage assessment' },
                { label: 'Recorded onset time', source: 'Triage assessment' },
              ],
              evidence: ['Unilateral weakness plus dysarthria, with an onset time inside 4.5 hours.'],
              model: 'pathway-detect v3.3.0',
              limits: [
                'Reads the triage text. A presentation nobody has written down does not reach it.',
                'It prompts and never activates. The manual button is always present and never gated on this.',
                'It has no view of the examination you have just done.',
              ],
            }}
          />
        )}

        {!activated ? (
          <>
            {/* The one-tap action, first on the page. */}
            <Card className="items-center p-[24px] text-center md:p-[40px]">
              <h2 className="text-[22px] font-semibold tracking-[-0.01em] md:text-[26px]">Activate a code stroke</h2>
              <p className="mx-auto mt-[8px] max-w-[512px] text-[15px] text-sh-text-2">One tap starts the clock, pages the team and puts the case on the network wall. Nothing below is required first.</p>
              <button
                type="button"
                onClick={activate}
                className="mx-auto mt-[24px] flex min-h-[80px] w-full max-w-[448px] items-center justify-center gap-[12px] rounded-sh-card bg-sh-crit-solid px-[32px] text-[18px] font-bold tracking-[0.02em] text-sh-on-crit-solid transition-[filter] duration-150 hover:brightness-110 active:scale-[0.99] md:text-[20px]"
              >
                <Icon icon={Siren} size={26} />
                ACTIVATE CODE STROKE
              </button>
              <p className="mt-[12px] text-[14px] text-sh-text-2">Always enabled · works offline · works with the AI off</p>
            </Card>

            <Why label="What one tap does — six things, in parallel">
              <ul className="flex flex-col divide-y divide-(--line)">
                {TRIGGERS.map((t) => (
                  <li key={t.label} className="flex items-start gap-[12px] py-[8px]">
                    <span className="flex size-[32px] shrink-0 items-center justify-center rounded-full bg-sh-pend-bg text-sh-pend-fg">
                      <Icon icon={t.icon} size={15} />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium text-sh-text">{t.label}</span>
                      <span className="block text-[13px] text-sh-text-2">{t.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Why>

            <Card titleSize="sm" title="Optional context" right={<span className="text-[13px] text-sh-text-2">none of it gates the activation</span>} headerClassName="flex-wrap">
              <div className="grid gap-[16px] md:grid-cols-3">
                <Field label="Facility" htmlFor="act-site">
                  <Select id="act-site" value={site} onChange={(e) => setSite(e.target.value)}>
                    {FACILITIES.map((f) => (
                      <option key={f.code} value={f.code}>
                        {f.code} · {f.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="How they arrived" htmlFor="act-source">
                  <Select id="act-source" value={source} onChange={(e) => setSource(e.target.value)}>
                    {SOURCES.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Last known well" htmlFor="act-lkw" hint="Unknown is acceptable">
                  <TextInput id="act-lkw" type="time" value={lkw} onChange={(e) => setLkw(e.target.value)} />
                </Field>
              </div>
            </Card>
          </>
        ) : (
          <>
            <Alert tone="info" icon={CircleCheck} role="status" title={`Activated · STROKE/26-27/${ACTIVE_CASE.id}`}>
              The clock started at {formatTime(caseNow)}, stamped from the server. The team has been paged and the case is on the wall.
            </Alert>

            {/* Who has not answered is the thing to act on; who has is one tap away. */}
            <Card
              titleSize="sm"
              title="Paging"
              right={
                unanswered.length > 0 ? (
                  <CountBubble className="bg-sh-warn-bg text-sh-warn-fg">{`Unanswered · ${unanswered.length}`}</CountBubble>
                ) : (
                  <CountBubble className="bg-sh-inner">all answered</CountBubble>
                )
              }
            >
              {unanswered.length === 0 ? <p className="text-[14px] text-sh-text-2">Everyone paged has answered.</p> : <ul className="flex flex-col divide-y divide-(--line)">{unanswered.map(pageRow)}</ul>}
              {answered.length > 0 && (
                <Disclosure label="answered" count={answered.length} className="mt-[4px]">
                  <ul className="flex flex-col divide-y divide-(--line)">{answered.map(pageRow)}</ul>
                </Disclosure>
              )}
            </Card>

            <div className="flex flex-wrap gap-[8px]">
              {next.map((n) => (
                <Pill key={n.to} variant={n.primary ? 'primary' : 'control'} size="xl" icon={n.icon} onClick={() => navigate(n.to)}>
                  {n.label}
                </Pill>
              ))}
            </div>
          </>
        )}
      </div>
    </ScreenFrame>
  )
}
