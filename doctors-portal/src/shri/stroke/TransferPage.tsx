/**
 * S-18-19 · Transfer — `/stroke/case/:id/transfer` (`src/screens/m18/
 * S1819.tsx`): "One action that holds an ambulance, a cath lab, an
 * anaesthetist and a bed."
 *
 * DD-012 is why the screen has this shape: the single-act reservation holds a
 * bed, a cath lab and an ambulance ATOMICALLY — "the exception that justifies
 * itself", the one place the flagship reaches across module boundaries,
 * because a transfer with three of four resources is not a transfer. So the
 * hold is all-or-nothing, a partial failure names the resource that failed,
 * the needle comes before loading (drip-and-ship), and door-out is stamped
 * once, at the server time.
 *
 * Removed, as a forecast (decision 8): AI-616's transfer ETA and its Why?.
 * Removed as an old defect: "Why this one goes by air", which contradicted the
 * route's own mode (a 42 km blue-light road run). The DIDO interval's blocking
 * step is shown while the interval runs, not after door-out. Another case than
 * the one this reservation was made for is told nothing is recorded (`NotLvo`).
 */

import { Ambulance, ArrowRight, Ban, Building2, Check, Clock, Hospital, Lock, TriangleAlert, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { TRANSFER_RESERVATION, TRANSFER_ROUTE, type StrokeCase } from '@/data/stroke'
import { useCurrentStaff } from '@/store/session'
import { useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock, useLiveIntervals } from '../logic/caseClock'
import { isIndexCase, useStrokeCaseParam } from '../logic/strokeCase'
import { Alert } from '../ui/Alert'
import { ClockRing } from '../ui/ClockRing'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Disclosure, Why } from '../ui/Disclosure'
import { KeyValue } from '../ui/KeyValue'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { NoCase, NotRecordedHere } from './NotLvo'

/** What travels ahead of the patient. Folded — it is a checklist, not a decision. */
const HANDOVER_PACK = [
  'Imaging, pushed ahead of the patient',
  'NIHSS with the examiner named',
  'Thrombolysis time, dose and second checker',
  'Every stamped clock event',
  'Allergies and the medication list',
  'Next of kin and the consent discussion',
]

export function TransferPage() {
  const { id, strokeCase: c } = useStrokeCaseParam()
  if (!c) return <NoCase screenId="S-18-19" id={id} />
  if (!isIndexCase(c)) return <NotRecordedHere key={c.id} c={c} screenId="S-18-19" heading="Transfer" />
  return <Transfer key={c.id} c={c} />
}

function Transfer({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const caseNow = useCaseClock()
  const intervals = useLiveIntervals()
  const reservationHeld = useStroke((s) => s.reservationHeld)
  const reservationAt = useStroke((s) => s.reservationAt)
  const holdReservation = useStroke((s) => s.holdReservation)
  const releaseReservation = useStroke((s) => s.releaseReservation)
  const stamp = useStroke((s) => s.stamp)
  const stamps = useStroke((s) => s.stamps)
  const p = patient(c.patientId)

  const [confirmHold, setConfirmHold] = useState(false)
  const [simulateFailure, setSimulateFailure] = useState(false)

  const isStamped = (key: string) => stamps.some((s) => s.key === key)
  const dido = intervals.find((i) => i.key === 'dido')
  const needleGiven = isStamped('needle')
  const doorOut = isStamped('door-out')
  /** All four, or none. */
  const allAvailable = TRANSFER_RESERVATION.every((r) => r.status === 'available') && !simulateFailure
  const failedResource = simulateFailure ? TRANSFER_RESERVATION[1] : null
  const clock = `/stroke/case/${c.id}/clock`

  return (
    <ScreenFrame
      screenId="S-18-19"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Transfer"
      sub={
        <>
          {dido && <span className="tabular-nums">DIDO {dido.elapsed}/{dido.targetMin} min · </span>}
          {reservationHeld ? 'four resources held' : 'nothing held yet'}
        </>
      }
      chips={
        dido?.state === 'BREACH' && (
          <PillTag tone="crit" size="sm" icon={TriangleAlert}>
            DIDO breached
          </PillTag>
        )
      }
      actions={
        may(clock) && (
          <Pill variant="card" size="xl" icon={Clock} iconSize={17} onClick={() => navigate(clock)}>
            Case clock
          </Pill>
        )
      }
      railTitle="Transfer"
      rail={
        <div className="flex flex-col gap-[12px]">
          <Card titleSize="sm" title="The DIDO clock">
            {dido && (
              <div className="flex justify-center">
                <ClockRing label={dido.label} elapsedMin={dido.elapsed} targetMin={dido.targetMin} state={dido.state} size={110} />
              </div>
            )}
            <p className="mt-[8px] text-center text-[14px] text-sh-text-2">Door-in to door-out at the spoke</p>
            {dido?.blockingStep && dido.state !== 'DONE' && <p className="mt-[8px] rounded-[12px] bg-sh-crit-bg px-[12px] py-[8px] text-[13px] font-medium text-sh-crit-fg">{dido.blockingStep}</p>}
          </Card>
          <Why label="Why all four or none">
            <p>
              An ambulance with no cath lab at the other end is a two-hour journey to a closed door. A cath lab with no anaesthetist is a team standing around. The reservation is
              atomic because a transfer with three of four resources is not a transfer.
            </p>
            <p className="text-sh-text-3">DD-012 · the one place the flagship reaches across module boundaries, and the reason it is allowed to.</p>
          </Why>
        </div>
      }
      actionBar={
        reservationHeld ? (
          <>
            <Pill variant="control" size="bar" icon={Undo2} onClick={releaseReservation}>
              Release the reservation
            </Pill>
            <span className="text-[13px] tabular-nums text-sh-norm-fg">Held since {reservationAt ? formatTime(reservationAt) : '—'} · all four</span>
            <Pill
              variant="primary"
              size="bar"
              icon={Ambulance}
              className="ml-auto"
              disabled={doorOut}
              onClick={() => {
                stamp('door-out', 'Door-out', me.name)
                toast({ tone: 'success', title: 'Door-out stamped', detail: `DIDO closed at ${dido?.elapsed} min. The ambulance is loaded and moving.` })
              }}
            >
              {doorOut ? 'Door-out stamped' : 'Load and stamp door-out'}
            </Pill>
          </>
        ) : (
          <>
            <Pill variant="control" size="bar" icon={TriangleAlert} title="Show what a partial failure looks like" onClick={() => setSimulateFailure((v) => !v)}>
              {simulateFailure ? 'Restore the cath lab' : 'Simulate a lost resource'}
            </Pill>
            <span className="text-[13px] text-sh-text-3">{allAvailable ? 'All four are available' : `${failedResource?.resource} is no longer available`}</span>
            <Pill variant="primary" size="bar" icon={Lock} className="ml-auto" disabled={!allAvailable} onClick={() => setConfirmHold(true)}>
              Hold all four
            </Pill>
          </>
        )
      }
    >
      <div className="flex flex-col gap-[20px]">
        {!needleGiven && (
          <Alert tone="warn" title="The needle has not been stamped">
            This is a drip-and-ship transfer, so the bolus is given before the patient is loaded. Loading first is why the task board blocks that step.
          </Alert>
        )}
        {!allAvailable && (
          <Alert tone="crit" role="alert" title={`${failedResource?.resource} is no longer available`}>
            The whole reservation is refused rather than partially committed. {failedResource?.detail} — {failedResource?.ownerModule} owns it, and it has been taken by another case.
            Nothing has been held, so you are not half-committed to a transfer you cannot complete.
          </Alert>
        )}
        {reservationHeld && (
          <Alert tone="info" icon={Lock} title="All four held atomically">
            Reserved at {reservationAt ? formatTime(reservationAt) : '—'} by {me.name}. If any one of them is lost, the whole hold is released and you are told which — you will never
            discover it on arrival.
          </Alert>
        )}

        <section className="flex flex-col gap-[10px]" aria-labelledby="resources-h">
          <div className="flex flex-wrap items-baseline gap-x-[10px]">
            <h2 id="resources-h" className="text-[17px] font-medium text-sh-text">
              The four resources
            </h2>
            <span className="text-[13px] text-sh-text-3">Held together, or not at all</span>
          </div>
          <div className="grid gap-[16px] sm:grid-cols-2">
            {TRANSFER_RESERVATION.map((r) => {
              const lost = simulateFailure && r.key === 'cathlab'
              return (
                <Card key={r.key} className={cn('p-[16px]', reservationHeld && 'shadow-[inset_0_0_0_1px_var(--norm)]', lost && 'bg-sh-crit-bg')}>
                  <div className="flex flex-wrap items-start justify-between gap-[8px]">
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold text-sh-text">{r.resource}</p>
                      <p className="text-[14px] text-sh-text-2">{r.detail}</p>
                    </div>
                    <PillTag tone={lost ? 'crit' : reservationHeld ? 'norm' : 'neu'} size="sm" icon={lost ? Ban : reservationHeld ? Lock : Check}>
                      {lost ? 'taken' : reservationHeld ? 'held' : r.status}
                    </PillTag>
                  </div>
                </Card>
              )
            })}
          </div>
        </section>

        <Card titleSize="sm" title="The journey">
          <div className="flex flex-wrap items-center gap-[12px]">
            <span className="flex items-center gap-[8px] font-semibold text-sh-text">
              <Icon icon={Building2} size={16} className="text-sh-text-3" />
              {TRANSFER_ROUTE.from}
            </span>
            <Icon icon={ArrowRight} size={16} className="text-sh-text-3" />
            <span className="flex items-center gap-[8px] font-semibold text-sh-text">
              <Icon icon={Hospital} size={16} className="text-sh-text-3" />
              {TRANSFER_ROUTE.to}
            </span>
          </div>
          <dl className="mt-[16px] grid gap-[12px] sm:grid-cols-2">
            <div className="rounded-[14px] bg-sh-inner px-[14px] py-[12px]">
              <dt className="text-[12px] uppercase tracking-[0.06em] text-sh-text-3">Distance</dt>
              <dd className="mt-[4px] text-[18px] font-semibold tabular-nums text-sh-text">{TRANSFER_ROUTE.distanceKm} km</dd>
            </div>
            <div className="rounded-[14px] bg-sh-inner px-[14px] py-[12px]">
              <dt className="text-[12px] uppercase tracking-[0.06em] text-sh-text-3">Mode</dt>
              <dd className="mt-[4px] font-semibold text-sh-text">{TRANSFER_ROUTE.mode}</dd>
            </div>
          </dl>
        </Card>

        <Disclosure label="handover pack" count={HANDOVER_PACK.length}>
          <div className="px-[12px] pb-[8px] pt-[4px]">
            <ul className="grid gap-[6px] sm:grid-cols-2">
              {HANDOVER_PACK.map((t) => (
                <li key={t} className="flex items-start gap-[8px] text-[14px] text-sh-text-2">
                  <Icon icon={Check} size={13} className="mt-[4px] text-sh-norm-fg" />
                  {t}
                </li>
              ))}
            </ul>
            <p className="mt-[10px] text-[13px] text-sh-text-3">The pack travels before the ambulance does, so the receiving team is reading it while the patient is in the air.</p>
          </div>
        </Disclosure>
      </div>

      <ConfirmDialog
        open={confirmHold}
        title="Hold all four resources?"
        consequence="The ambulance, the cath lab, the anaesthetist and the neuro-ICU bed are reserved in one atomic action. If any one of them cannot be held, none is — and you are told which failed. Holding them takes them away from other cases, so release the hold if the transfer is called off."
        confirmLabel="Hold all four"
        onConfirm={() => {
          if (!allAvailable) return
          holdReservation()
          setConfirmHold(false)
          toast({ tone: 'success', title: 'Four resources held', detail: `Atomic reservation by ${me.name} at ${formatTime(caseNow)}.` })
        }}
        onCancel={() => setConfirmHold(false)}
      >
        <dl className="flex flex-col divide-y divide-sh-line">
          {TRANSFER_RESERVATION.map((r) => (
            <KeyValue key={r.key} label={r.resource}>
              {r.detail}
            </KeyValue>
          ))}
        </dl>
      </ConfirmDialog>
    </ScreenFrame>
  )
}
