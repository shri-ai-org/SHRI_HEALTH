/**
 * S-18-02 · Case view — in place over S-18-01 (`src/screens/m18/S1802.tsx`):
 * "One case, expanded without leaving the wall."
 *
 * It has no route and is not a modal in the usual sense: it expands over the
 * wall (its Z7b line reads "⊘ absent — rendered within S-18-01"), because a
 * wall operator who navigates away loses the wall. The three live intervals
 * in full, the completed ones one tap away; imaging and team one line each,
 * each linking to the screen that owns the detail.
 *
 * Removed, as a forecast (decision 8): AI-209's "projected to breach in N
 * minutes" — the alert here is for an interval that HAS breached. Where the
 * old view fell short: it drew the index case's clocks, pages and tasks on
 * every case (another case now says none are recorded); Esc did nothing and
 * focus stayed on the wall under it (it is a focus-trapped layer now, and Esc
 * goes back to the wall); its links went to screens the persona could not
 * open (absent now, GP-02).
 */

import { motion } from 'framer-motion'
import { Ambulance, Ban, Clock, Scan, Syringe, Timer, TriangleAlert, Users, X } from 'lucide-react'
import { useEffect, useId } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { IMAGING_TRIAGE, STROKE_TASKS, strokeCase } from '@/data/stroke'
import { triageHeadline } from '@/data/strokeai'

import { useMayOpenPath } from '../app/landing'
import { cn } from '../lib/cn'
import { popover } from '../lib/motion'
import { atRisk, useCaseNow, useLiveIntervals, type LiveInterval } from '../logic/caseClock'
import { isIndexCase, pagingFor } from '../logic/strokeCase'
import { useAiActive } from '../state/ai'
import { Alert } from '../ui/Alert'
import { ClockRing } from '../ui/ClockRing'
import { Disclosure } from '../ui/Disclosure'
import { useFocusTrap } from '../ui/hooks'
import { Diamond, Icon, Pill, PillTag } from '../ui/primitives'
import { Scrim } from '../ui/Scrim'

import { NoStream } from './StrokeBits'

export function CaseView({ caseId, onClose }: { caseId: string | null; onClose: () => void }) {
  if (!caseId) return null
  return <Expanded caseId={caseId} onClose={onClose} />
}

function Expanded({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const all = useLiveIntervals()
  const caseNow = useCaseNow()
  const ref = useFocusTrap<HTMLDivElement>(true)
  const titleId = useId()

  // Esc goes back to the wall, and nothing underneath hears it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const c = strokeCase(caseId)
  const p = patient(c.patientId)
  const own = isIndexCase(c)
  const intervals = own ? all : []
  const breached = intervals.filter(atRisk)
  const live = intervals.filter((i) => i.state !== 'DONE')
  const done = intervals.filter((i) => i.state === 'DONE')
  const paging = pagingFor(c)
  const inProgress = own ? STROKE_TASKS.filter((t) => t.column === 'In progress' || t.column === 'Blocked') : []
  const lvo = IMAGING_TRIAGE.findings.find((f) => f.label === 'LVO')
  const ich = IMAGING_TRIAGE.findings.find((f) => f.label === 'ICH')

  const base = `/stroke/case/${c.id}`
  const links = [
    { to: `${base}/imaging`, label: 'Imaging', icon: Scan },
    { to: `${base}/thrombolysis`, label: 'Thrombolysis', icon: Syringe },
    { to: `${base}/transfer`, label: 'Transfer', icon: Ambulance },
  ].filter((l) => may(l.to))

  const ring = (i: LiveInterval, size: number) => (
    <div key={i.key} className="flex w-[104px] flex-col items-center text-center">
      <ClockRing label={i.label} elapsedMin={i.elapsed} targetMin={i.targetMin} state={i.state} size={size} />
      <p className="mt-[4px] text-[12px]/[1.25] text-sh-text-2">{i.label}</p>
    </div>
  )

  const imagingLink = may(`${base}/imaging`) && (
    <Pill variant="control" size="lg" icon={Scan} onClick={() => navigate(`${base}/imaging`)}>
      Imaging
    </Pill>
  )

  return (
    <>
      <Scrim onClick={onClose} className="z-55" />
      <div className="fixed inset-0 z-60 overflow-y-auto pb-(--sa-b) pl-(--sa-l) pr-(--sa-r) pt-(--sa-t)">
        <motion.div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-screen-id="S-18-02"
          variants={popover}
          initial="hidden"
          animate="shown"
          className="mx-auto my-[16px] w-[calc(100%-32px)] max-w-[1024px] rounded-sh-modal bg-sh-card p-[20px] text-sh-text shadow-sh-modal md:my-[32px] md:p-[28px]"
        >
          <header className="flex flex-wrap items-start justify-between gap-[12px]">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[20px] font-semibold tabular-nums tracking-[-0.01em] md:text-[26px]">
                {c.caseNo}
              </h2>
              <p className="mt-[2px] text-[15px] tabular-nums text-sh-text-2 md:text-[18px]">
                {p.name} · {p.age}/{p.sex} · {c.originFacility} → {c.destinationFacility} · LKW {formatTime(c.lkw)}
              </p>
              <p className="mt-[8px] flex flex-wrap items-center gap-[8px]">
                <PillTag tone="neu" size="sm">
                  {c.payer}
                </PillTag>
                <PillTag tone="pend" size="sm">
                  NIHSS {c.nihss}
                </PillTag>
                {c.breakGlassBy && (
                  <PillTag tone="warn" size="sm" icon={TriangleAlert}>
                    break-glass: {c.breakGlassBy}
                  </PillTag>
                )}
              </p>
            </div>
            <Pill variant="control" size="lg" icon={X} onClick={onClose}>
              Back to the wall
            </Pill>
          </header>

          {/* The live clocks, larger than on the card. Completed ones fold. */}
          <section className="mt-[24px]">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Live intervals</h3>
            {own ? (
              <>
                <div className="mt-[12px] flex flex-wrap gap-[16px]">{live.map((i) => ring(i, 80))}</div>
                {done.length > 0 && (
                  <Disclosure label="all intervals" count={intervals.length} className="mt-[12px]">
                    <div className="flex flex-wrap gap-[16px] px-[4px] pt-[4px]">{done.map((i) => ring(i, 64))}</div>
                  </Disclosure>
                )}
              </>
            ) : (
              <NoStream caseNo={c.caseNo} what="intervals" className="mt-[8px] text-[14px] text-sh-text-2" />
            )}
          </section>

          {/* The operative alert: what has breached, and who moves it. */}
          {breached.map((b) => (
            <Alert key={b.key} tone="crit" icon={TriangleAlert} role="alert" className="mt-[20px]" title={`${b.label} past its ${b.targetMin}-minute target`}>
              {b.blockingStep && (
                <p>
                  <strong className="text-sh-text">Blocking:</strong> {b.blockingStep}
                </p>
              )}
              <p className="mt-[2px]">
                <strong className="text-sh-text">Next action:</strong> {b.nextAction} — owner {b.owner}
              </p>
            </Alert>
          ))}

          {/* Imaging and team, one line each, each linking to the screen that owns it. */}
          <ul className="mt-[20px] divide-y divide-(--line) rounded-[16px] bg-sh-inner">
            {aiActive && !c.imaging.lvo && (
              <li className="flex min-h-[56px] flex-wrap items-center justify-between gap-[8px] px-[16px] py-[8px]">
                <span className="flex flex-wrap items-center gap-[8px] text-[15px]">
                  <Diamond />
                  <span className="font-semibold">{triageHeadline(c)}</span>
                  <span className="text-[13px] text-sh-text-2">· G3 confirm required</span>
                </span>
                {imagingLink}
              </li>
            )}
            {aiActive && c.imaging.lvo && lvo && ich && (
              <li className="flex min-h-[56px] flex-wrap items-center justify-between gap-[8px] px-[16px] py-[8px]">
                <span className="flex flex-wrap items-center gap-[8px] text-[15px]">
                  <Diamond />
                  <span className="font-semibold">LVO · {lvo.value.replace('LEFT ', '')}</span>
                  <span className="text-sh-text-3">·</span>
                  <span className={cn(ich.emphasisNegative && 'font-semibold text-sh-norm-fg')}>ICH {ich.value.toLowerCase()}</span>
                  <span className="text-[13px] text-sh-text-2">· G3 confirm required</span>
                </span>
                {imagingLink}
              </li>
            )}
            <li className="flex min-h-[56px] flex-wrap items-center justify-between gap-[8px] px-[16px] py-[8px]">
              <span className="flex flex-wrap items-center gap-[8px] text-[15px] tabular-nums">
                <Icon icon={Users} size={15} className="text-sh-text-3" />
                {own ? (
                  <>
                    <span className="font-semibold">
                      {paging.acked.length} of {paging.log.length} answered
                    </span>
                    {paging.unanswered.length > 0 && (
                      <PillTag tone="crit" size="sm" icon={TriangleAlert}>
                        {paging.unanswered.length} no answer
                      </PillTag>
                    )}
                  </>
                ) : (
                  <NoStream caseNo={c.caseNo} what="pages" className="text-sh-text-2" />
                )}
              </span>
              {own && may(`${base}/team`) && (
                <Pill variant="control" size="lg" icon={Users} onClick={() => navigate(`${base}/team`)}>
                  Team
                </Pill>
              )}
            </li>
          </ul>

          {/* What is moving right now. */}
          <section className="mt-[20px]">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">In progress</h3>
            {own ? (
              <ul className="mt-[8px] divide-y divide-(--line)">
                {inProgress.map((t) => (
                  <li key={t.id} className="flex min-h-[48px] flex-wrap items-center justify-between gap-[8px] py-[8px] text-[14px]">
                    <span className="min-w-0">
                      {t.label} · <span className="text-sh-text-2">{t.owner}</span>
                    </span>
                    <PillTag tone={t.column === 'Blocked' ? 'crit' : 'warn'} size="sm" icon={t.column === 'Blocked' ? Ban : Timer}>
                      {t.column}
                      {t.dueInMin !== null && ` · ${t.dueInMin}m`}
                    </PillTag>
                  </li>
                ))}
              </ul>
            ) : (
              <NoStream caseNo={c.caseNo} what="tasks" className="mt-[8px] text-[14px] text-sh-text-2" />
            )}
          </section>

          <footer className="mt-[20px] flex flex-wrap items-center gap-[8px]">
            {may(`${base}/clock`) && (
              <Pill variant="primary" size="lg" icon={Clock} onClick={() => navigate(`${base}/clock`)}>
                Open the case clock
              </Pill>
            )}
            {links.map((l) => (
              <Pill key={l.label} variant="control" size="lg" icon={l.icon} onClick={() => navigate(l.to)}>
                {l.label}
              </Pill>
            ))}
            <span className="ml-auto self-center text-[13px] tabular-nums text-sh-text-2">server {formatTime(caseNow)}</span>
          </footer>
        </motion.div>
      </div>
    </>
  )
}
