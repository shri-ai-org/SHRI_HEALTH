/**
 * S-18-06 · Case clock — `/stroke/case/:id/clock` (`src/screens/m18/
 * S1806.tsx`): "Every clock in the room, on one screen, with an owner for the
 * next action."
 *
 * The owner line is what turns a dashboard into a coordination tool, so each
 * running ring carries "next · owner"; the completed ones fold. Stamping is
 * one tap, or `e` on the focused event, and the stream is APPEND-ONLY — a
 * stamped event cannot be stamped again. A breach reason is captured AT THE
 * MOMENT OF BREACH, not reconstructed at audit. With the AI off the screen is
 * entirely unaffected: no interval, target or clock value is AI-derived.
 *
 * Removed, as a forecast (decision 8): AI-209's projected-breach banner
 * ("projected to breach in N minutes"), its Why? and its model line. The
 * breach-reason capture it carried moves to a plain, non-AI alert on an
 * interval that HAS breached — over its target and unstamped — so it no
 * longer hangs on a prediction, and it is there with the AI off.
 *
 * Where the old screen fell short: a stray `e` anywhere on the page stamped
 * the needle (only the event with focus is stamped now); stamps, breach
 * reasons and de-activation wrote no record (each is audited, at case time);
 * the offline note said stamps are marked pending and none was; de-activation
 * kept neither the reason chosen nor the case off the wall (both are kept);
 * the index case's clock was drawn on every case (another case says none is
 * recorded, and offers nothing to stamp into 0141's stream); an unknown case
 * id threw.
 */

import { Ambulance, Ban, Check, Columns2, PenLine, Syringe, Timer, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { STAMPABLE_EVENTS, type StrokeCase } from '@/data/stroke'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { atRisk, shortLabel, useCaseClock, useLiveIntervals, type LiveInterval } from '../logic/caseClock'
import { useStrokeActions } from '../logic/strokeActions'
import { isIndexCase, useStrokeCaseParam } from '../logic/strokeCase'
import { useForcedState } from '../state/ai'
import { Alert } from '../ui/Alert'
import { ClockRing } from '../ui/ClockRing'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Disclosure, Why } from '../ui/Disclosure'
import { Field, Select, TextArea } from '../ui/forms'
import { Card, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { NoStream, NoSuchCase } from './StrokeBits'
import { useStrokeLocal } from './strokeLocal'

const BREACH_REASONS = ['Ambulance not yet loaded', 'Awaiting family consent', 'Imaging queue', 'Receiving site not ready', 'Clinical instability', 'Other']
const DEACTIVATION_REASONS = ['Stroke mimic — seizure', 'Stroke mimic — migraine', 'Stroke mimic — hypoglycaemia', 'Diagnosis revised', 'Other']

export function CaseClockPage() {
  const { id, strokeCase } = useStrokeCaseParam()
  if (!strokeCase) return <NoSuchCase screenId="S-18-06" id={id} />
  return <CaseClock key={strokeCase.id} c={strokeCase} />
}

function CaseClock({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const forced = useForcedState()
  const caseNow = useCaseClock()
  const all = useLiveIntervals()
  const actions = useStrokeActions()
  const stamps = useStroke((s) => s.stamps)
  const breachReasons = useStroke((s) => s.breachReasons)
  const deactivation = useStrokeLocal((s) => s.deactivations[c.id])
  const deactivate = useStrokeLocal((s) => s.deactivate)

  const [focused, setFocused] = useState<string | null>(null)
  const [breachFor, setBreachFor] = useState<LiveInterval | null>(null)
  const [reason, setReason] = useState(BREACH_REASONS[0])
  const [detail, setDetail] = useState('')
  const [deactivating, setDeactivating] = useState(false)
  const [deactivationReason, setDeactivationReason] = useState(DEACTIVATION_REASONS[0])

  const p = patient(c.patientId)
  const own = isIndexCase(c)
  const intervals = own ? all : []
  const running = intervals.filter((i) => i.state !== 'DONE')
  const completed = intervals.filter((i) => i.state === 'DONE')
  const breached = intervals.filter(atRisk)
  const live = c.status === 'active' && !deactivation
  const base = `/stroke/case/${c.id}`
  const links = [
    { to: `${base}/tasks`, label: 'Task board', icon: Columns2 },
    { to: `${base}/thrombolysis`, label: 'Eligibility', icon: Syringe },
    { to: `${base}/transfer`, label: 'Transfer', icon: Ambulance },
  ].filter((l) => may(l.to))
  const reasonFor = (key: string) => breachReasons.find((b) => b.intervalKey === key)

  const stampedAt = (e: (typeof STAMPABLE_EVENTS)[number]) => e.stamped ?? stamps.find((s) => s.key === e.key)?.at

  function closeBreach() {
    setBreachFor(null)
    setDetail('')
    setReason(BREACH_REASONS[0])
  }

  /** One interval: the ring, its name, and the one line that makes it a coordination tool. */
  const tile = (i: LiveInterval, full: boolean) => (
    <li key={i.key} className={cn('flex min-w-0 flex-col items-center rounded-[16px] px-[12px] py-[12px] text-center', full ? 'w-[176px]' : 'w-[144px]', atRisk(i) && 'bg-sh-crit-bg')}>
      <ClockRing label={i.label} elapsedMin={i.elapsed} targetMin={i.targetMin} state={i.state} size={full ? 88 : 64} />
      <p className={cn('mt-[6px] font-semibold leading-tight', full ? 'text-[14px]' : 'text-[13px] text-sh-text-2')}>{i.label}</p>
      {full ? (
        <p className="mt-[4px] text-[13px]/[1.4] text-sh-text-2">
          <span className="text-sh-text-3">next: </span>
          {i.nextAction}
          <span className="text-sh-text-3"> · </span>
          <span className="font-medium text-sh-text">{i.owner}</span>
        </p>
      ) : (
        i.stamp && <p className="mt-[2px] text-[12px] tabular-nums text-sh-text-2">done {formatTime(i.stamp)}</p>
      )}
    </li>
  )

  return (
    <ScreenFrame
      screenId="S-18-06"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Case clock"
      sub={`${running.length} running · ${breached.length} breached · ${completed.length} complete`}
      chips={
        !live && (
          <PillTag tone="neu" size="sm" icon={Ban}>
            {deactivation ? `De-activated ${formatTime(deactivation.at)}` : c.status === 'closed' ? 'Closed' : 'De-activated'}
          </PillTag>
        )
      }
      actions={
        links.length > 0 && (
          <>
            {links.map((l) => (
              <Pill key={l.to} variant="card" size="xl" icon={l.icon} iconSize={17} onClick={() => navigate(l.to)}>
                {l.label}
              </Pill>
            ))}
          </>
        )
      }
      railTitle="Coordination"
      rail={
        <div className="flex flex-col gap-[12px]">
          {may(`${base}/events`) && (
            <Card titleSize="sm" title="Reconcile">
              <div>
                <Pill variant="control" size="lg" icon={Columns2} onClick={() => navigate(`${base}/events`)}>
                  Reconcile a timestamp
                </Pill>
              </div>
            </Card>
          )}
          <Why label="Which clock wins, and what the AI does here">
            <p>
              The server clock. Local device times are reconciled against it and never trusted. A disputed door time is a disputed door-to-needle — so corrections go through the reconciliation screen as audited amendments, never as overwrites.
            </p>
            <p>The owner column is what turns a dashboard into a coordination tool. An interval with no owner is an interval nobody is progressing.</p>
            {/* The old line ended "Only the projected-breach line is hidden." — there is no projection any more. */}
            <p className="text-sh-text-3">With the AI off this screen is entirely unaffected: no interval, target or clock value is AI-derived.</p>
          </Why>
        </div>
      }
      actionBar={
        <>
          <span className="text-[13px] tabular-nums text-sh-text-2">
            server {formatTime(caseNow)}:{String(caseNow.getSeconds()).padStart(2, '0')} · press <kbd className="rounded-[6px] bg-sh-inner px-[6px] py-[2px] font-mono text-[12px] text-sh-text">e</kbd> to stamp the focused event
          </span>
          {live && (
            <Pill variant="crit" size="bar" icon={Ban} className="ml-auto" onClick={() => setDeactivating(true)}>
              De-activate the case
            </Pill>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {forced === 'OFFLINE' && (
          <Alert tone="warn" title="Stamping is queueing locally">
            Each stamp is marked pending until it reaches the server, where its time is reconciled against the server clock.
          </Alert>
        )}

        {deactivation && (
          <Alert tone="info" icon={Ban} title={`De-activated ${formatTime(deactivation.at)} by ${deactivation.by}`}>
            {deactivation.reason}. The clock is closed. The record remains.
          </Alert>
        )}

        {/* An interval past its target, unstamped: recorded, not predicted. The reason is captured now, while it is true. */}
        {breached.map((b) => {
          const captured = reasonFor(b.key)
          return (
            <Alert
              key={b.key}
              tone="crit"
              icon={TriangleAlert}
              role="alert"
              title={`${b.label} has breached its ${b.targetMin}-minute target`}
              action={
                captured ? (
                  <PillTag tone="neu" size="sm" icon={Check}>
                    reason captured {formatTime(captured.at)}
                  </PillTag>
                ) : (
                  <Pill variant="crit" size="lg" icon={PenLine} onClick={() => setBreachFor(b)}>
                    Capture the reason
                  </Pill>
                )
              }
            >
              {b.blockingStep && (
                <p>
                  <strong className="text-sh-text">Blocking:</strong> {b.blockingStep}
                </p>
              )}
              <p>
                <strong className="text-sh-text">Next action:</strong> {b.nextAction} — owner {b.owner}
              </p>
            </Alert>
          )
        })}

        {/* The running intervals, each with its next action and owner. */}
        <Card titleSize="sm" title="Intervals" right={own && <CountBubble className={breached.length > 0 ? 'bg-sh-crit-bg text-sh-crit-fg' : 'bg-sh-pend-bg text-sh-pend-fg'}>{`Running · ${running.length}`}</CountBubble>}>
          {!own ? (
            <NoStream caseNo={c.caseNo} what="intervals" />
          ) : running.length === 0 ? (
            <p className="text-[14px] text-sh-text-2">Every interval on this case is complete.</p>
          ) : (
            <ul className="flex flex-wrap gap-[8px]">{running.map((i) => tile(i, true))}</ul>
          )}
          {completed.length > 0 && (
            <Disclosure label="completed intervals" count={completed.length} className="mt-[4px]">
              <ul className="flex flex-wrap gap-[8px]">{completed.map((i) => tile(i, false))}</ul>
            </Disclosure>
          )}
        </Card>

        {/* Stamping. One tap or one keystroke; append-only. */}
        <Card titleSize="sm" title="Stamp an event" right={<span className="text-[13px] text-sh-text-2">one tap or one keystroke · append-only</span>} headerClassName="flex-wrap">
          {own ? (
            <div className="flex flex-wrap gap-[10px]">
              {STAMPABLE_EVENTS.map((e) => {
                const at = stampedAt(e)
                const done = at !== undefined && at !== null
                const fire = () => {
                  if (!done && live) actions.stamp(e.key, e.label)
                }
                return (
                  <button
                    key={e.key}
                    type="button"
                    onFocus={() => setFocused(e.key)}
                    onBlur={() => setFocused((f) => (f === e.key ? null : f))}
                    onClick={fire}
                    // `e` stamps the event that has focus — and only that one.
                    onKeyDown={(ev) => {
                      if (ev.key !== 'e' || ev.ctrlKey || ev.metaKey || ev.altKey) return
                      ev.preventDefault()
                      fire()
                    }}
                    disabled={done || !live}
                    aria-label={done ? `${e.label}, stamped ${formatTime(at)}` : `Stamp ${e.label}`}
                    className={cn(
                      'min-h-[56px] min-w-[160px] rounded-[16px] px-[16px] py-[10px] text-left transition-colors duration-150 disabled:cursor-not-allowed',
                      done ? 'bg-sh-norm-bg text-sh-norm-fg' : focused === e.key ? 'bg-sh-hover-strong text-sh-text inset-ring-2 inset-ring-(--pend-fg)' : 'bg-sh-inner text-sh-text hover:bg-sh-hover-strong',
                      !done && !live && 'opacity-50',
                    )}
                  >
                    <span className="flex items-center gap-[8px] font-semibold">
                      <Icon icon={done ? Check : Timer} size={15} />
                      {e.label}
                    </span>
                    <span className="mt-[2px] block text-[13px] tabular-nums">{done ? `stamped ${formatTime(at)}` : focused === e.key ? 'press e, or tap' : 'not stamped'}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <NoStream caseNo={c.caseNo} what="events" />
          )}
        </Card>

        {breachReasons.length > 0 && own && (
          <Card titleSize="sm" title="Breach reasons captured" right={<CountBubble className="bg-sh-inner">{breachReasons.length}</CountBubble>}>
            <ul className="flex flex-col divide-y divide-(--line)">
              {breachReasons.map((b, i) => (
                <li key={i} className="py-[10px]">
                  <p className="font-medium">{b.reason}</p>
                  {b.detail && <p className="text-[14px] text-sh-text-2">{b.detail}</p>}
                  <p className="mt-[4px] flex flex-wrap items-center gap-[8px] text-[13px] tabular-nums text-sh-text-2">
                    <PillTag tone="neu" size="xs">
                      {shortLabel(b.intervalKey)}
                    </PillTag>
                    captured {formatTime(b.at)} by {b.by}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={breachFor !== null}
        title="Capture the breach reason"
        consequence="This is recorded against the interval now, at the moment it happened. A reason written three weeks later at audit is not the same evidence, which is why the capture is here rather than in a report."
        confirmLabel="Record the reason"
        onConfirm={() => {
          if (!breachFor) return
          actions.captureBreach(breachFor.key, breachFor.label, reason, detail.trim() || undefined)
          closeBreach()
        }}
        onCancel={closeBreach}
      >
        <div className="flex flex-col gap-[12px]">
          <Field label="Breach reason" htmlFor="breach-reason">
            <Select id="breach-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              {BREACH_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <TextArea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Anything specific…" aria-label="Anything specific" />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deactivating}
        title="De-activate this case?"
        consequence="The clock closes and the case leaves the active wall. A de-activated case keeps its record and its reason — this is how a stroke mimic is recorded honestly rather than deleted."
        confirmLabel="De-activate with a reason"
        tone="destructive"
        onConfirm={() => {
          setDeactivating(false)
          deactivate(c.id, { reason: deactivationReason, at: caseNow, by: me.name })
          audit({
            event: 'STROKE.CASE_DEACTIVATED',
            actor: me.name,
            actorId: me.id,
            subject: p.id,
            at: caseNow.toISOString(),
            detail: `${c.caseNo} · ${deactivationReason} · de-activated ${formatTime(caseNow)}`,
            ...(forced === 'OFFLINE' ? { queued: true } : {}),
          })
          toast({ tone: 'caution', title: 'Case de-activated', detail: 'The clock is closed. The record remains.' })
          if (may('/stroke/wall')) navigate('/stroke/wall')
        }}
        onCancel={() => setDeactivating(false)}
      >
        <Select value={deactivationReason} onChange={(e) => setDeactivationReason(e.target.value)} aria-label="De-activation reason">
          {DEACTIVATION_REASONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </ConfirmDialog>
    </ScreenFrame>
  )
}
