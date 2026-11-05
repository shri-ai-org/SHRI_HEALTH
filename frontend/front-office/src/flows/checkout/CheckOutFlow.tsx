import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CalendarPlus, FileText, LogOut, XCircle } from 'lucide-react'
import { FlowSheet } from '../../components/flow/FlowSheet'
import { ScheduleFlow } from '../schedule/ScheduleFlow'
import { AckCard } from '../../components/flow/AckCard'
import { Quadrant, StepRail, SummaryItem, Waiting } from '../../components/flow/Quadrant'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { FieldError } from '../../components/patient/AgeConfirm'
import { useStoreValue } from '../../hooks/useStore'
import { getAppointmentById, getPatientById, getProviderById, getToday } from '../../domain/selectors'
import { dayWithDate } from '../../utils/dates'
import { formatTime } from '../../domain/time'
import { cn } from '../../utils/cn'
import { errorClass, inputClass, labelClass } from '../../utils/formClasses'
import type { FlowProps } from '../registry'
import {
  DeskBreakGlass,
  DeskRefusal,
  afterVisitSummaryUrl,
  checkOut,
  declineFollowUp,
  intervalLabel,
  loadCheckOut,
  markRevisitBooked,
} from '../../../shri-health/checkout'
import type { DeskFollowUp } from '../../../shri-health/checkout'
import { newIdempotencyKey } from '../../../shri-health/client'

const FOLLOW_UP_STATUS: Record<DeskFollowUp['status'], string> = {
  open: 'Requested by the doctor',
  booked: 'Revisit booked',
  declined: 'Declined',
  withdrawn: 'Withdrawn by the doctor',
}

/**
 * Check-out (D98): the visit, the doctor's follow-up request (book the revisit or decline it),
 * the after-visit summary, then Check out. Built new from care-entry's own flow pieces, as the
 * reschedule flow is (Minalini's exception of 2026-11-04: no source screen exists). The data is
 * mock until #161 merges (`shri-health/checkout.ts`).
 */
export function CheckOutFlow({ params, onClose }: FlowProps) {
  const today = useStoreValue(getToday)
  const appointment = useStoreValue(getAppointmentById, params.appointment ?? '')
  const patient = useStoreValue(getPatientById, appointment?.patientId ?? '')
  const provider = useStoreValue(getProviderById, appointment?.providerId ?? '')
  const providerId = appointment?.providerId ?? ''
  const appointmentId = appointment?.appointmentId ?? ''

  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [followUp, setFollowUp] = useState<DeskFollowUp | null>(null)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonTried, setReasonTried] = useState(false)
  const [busy, setBusy] = useState<'decline' | 'summary' | 'checkout' | null>(null)
  const [followUpError, setFollowUpError] = useState<string | null>(null)
  const [summaryNote, setSummaryNote] = useState<string | null>(null)
  const [summaryOpened, setSummaryOpened] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // The visit's encounter, from the appointment itself (list rows don't carry it).
  const [encounterId, setEncounterId] = useState<string | undefined>()
  const [booking, setBooking] = useState(false)
  // One key per attempt, reused only to retry the very same request.
  const [declineKey, setDeclineKey] = useState(newIdempotencyKey)
  const [checkOutKey] = useState(newIdempotencyKey)
  const followUpProvider = useStoreValue(getProviderById, followUp?.providerId ?? '')
  const revisit = useStoreValue(getAppointmentById, followUp?.bookedAppointmentId ?? '')

  useEffect(() => {
    if (!appointmentId) return
    let live = true
    loadCheckOut(appointmentId, providerId)
      .then((v) => {
        if (!live) return
        setFollowUp(v.followUp)
        setEncounterId(v.encounterId ?? undefined)
        setLoaded(true)
      })
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [appointmentId, providerId])

  const subtitle = patient ? `${patient.name} · ${patient.uhid}` : 'Visit'
  const sheet = (body: ReactNode, footer?: ReactNode) => (
    <FlowSheet title="Check out" subtitle={subtitle} icon={LogOut} iconTone="teal" onClose={onClose} footer={footer}>
      {body}
    </FlowSheet>
  )

  if (!appointment || !patient || !provider) return sheet(<Alert tone="warning">That visit no longer exists.</Alert>)
  if (loadError) return sheet(<Alert tone="critical" live>The visit could not be loaded. {loadError}</Alert>)
  if (!loaded) return sheet(<Waiting>Loading the visit…</Waiting>)

  // The revisit: care-entry's own Schedule Appointment, for this patient and the follow-up's doctor,
  // opened in place (its patient stays out of the address, D13) and back here once booked.
  if (booking) {
    return (
      <ScheduleFlow
        params={{ uhid: patient.patientId, doctor: followUp?.providerId }}
        followUpOfEncounterId={encounterId ?? appointment.serverEncounterId}
        onClose={() => setBooking(false)}
        onBooked={(bookedId) => {
          markRevisitBooked(appointmentId, providerId, bookedId)
          setFollowUp((f) => (f ? { ...f, status: 'booked', bookedAppointmentId: bookedId } : f))
          setBooking(false)
        }}
      />
    )
  }

  if (done) {
    return sheet(
      <div className="flex min-h-full items-center justify-center py-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-surface-1 px-6 shadow-card">
          <AckCard title="Checked Out" icon={LogOut} onDone={onClose}>
            <p className="text-base font-semibold text-ink">{patient.name}</p>
            <p>{followUp ? `${FOLLOW_UP_STATUS[followUp.status]} · ${intervalLabel(followUp.interval)}` : 'No follow-up requested'}</p>
          </AckCard>
        </div>
      </div>,
    )
  }

  const followUpSettled = !followUp || followUp.status !== 'open'
  const steps = [
    { label: 'Visit', done: true, target: 'checkout-visit' },
    { label: 'Follow-up', done: followUpSettled, target: 'checkout-follow-up' },
    { label: 'After-visit summary', done: summaryOpened, target: 'checkout-summary' },
  ]
  const currentIndex = steps.findIndex((step) => !step.done)
  const rail = steps.map((step, index) => ({ ...step, current: index === currentIndex }))
  async function onDecline() {
    setReasonTried(true)
    if (!reason.trim()) return
    setBusy('decline')
    setFollowUpError(null)
    try {
      setFollowUp(await declineFollowUp(appointmentId, providerId, reason, declineKey))
      setDeclining(false)
      setDeclineKey(newIdempotencyKey())
    } catch (e) {
      setFollowUpError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onSummary() {
    setBusy('summary')
    try {
      const url = await afterVisitSummaryUrl(appointmentId)
      if (url) {
        window.open(url, '_blank', 'noopener')
        setSummaryOpened(true)
      }
      setSummaryNote(url ? 'Opened in a new tab.' : 'There is no after-visit summary for this visit yet.')
    } catch (e) {
      // D109: a restricted chart's summary needs break-glass; the desk has no break-glass screen yet (gap 52).
      setSummaryNote(e instanceof DeskBreakGlass ? 'This chart is restricted: the summary needs break-glass, which the clinician can record.' : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onCheckOut() {
    setBusy('checkout')
    setError(null)
    setFollowUpError(null)
    try {
      await checkOut(appointmentId, providerId, checkOutKey)
      setDone(true)
    } catch (e) {
      if (e instanceof DeskRefusal && e.pointer === '/followUp') {
        setFollowUpError(e.message)
        document.getElementById('checkout-follow-up')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(null)
    }
  }

  const confirmBar = (
    <div className="flex flex-col gap-2.5">
      {error ? (
        <Alert tone="critical" live>
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-muted" aria-live="polite">
          {followUpSettled ? 'Ready to check out.' : 'Book the revisit or decline the follow-up first.'}
        </p>
        <Button size="lg" onClick={onCheckOut} disabled={busy !== null}>
          <LogOut className="h-4 w-4" strokeWidth={1.75} />
          {busy === 'checkout' ? 'Checking out…' : 'Check out'}
        </Button>
      </div>
    </div>
  )

  return sheet(
    <div className="flex flex-col gap-3 sm:gap-4">
      <StepRail steps={rail} />

      <Quadrant id="checkout-visit" step={1} title="Visit" done>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[1fr_1.6fr_0.8fr]">
          <SummaryItem label="Doctor" value={provider.name} />
          <SummaryItem label="When" value={`${dayWithDate(appointment.date, today)} · ${formatTime(appointment.slot)}`} />
          <SummaryItem label="How" value={appointment.mode} />
        </dl>
      </Quadrant>

      <Quadrant id="checkout-follow-up" step={2} title="Follow-up" done={followUpSettled} current={!followUpSettled}>
        <div className="flex flex-col gap-3">
          {followUpError ? (
            <Alert tone="critical" live>
              {followUpError}
            </Alert>
          ) : null}
          {!followUp ? (
            <p className="text-sm text-ink-muted">The doctor did not request a follow-up.</p>
          ) : (
            <>
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <SummaryItem label="Come back" value={intervalLabel(followUp.interval)} />
                <SummaryItem label="Visit type" value={followUp.appointmentTypeName ?? 'Any'} />
                <SummaryItem label="Doctor" value={followUpProvider?.name ?? 'Any'} />
              </dl>
              {followUp.note ? <p className="text-sm text-ink">{followUp.note}</p> : null}
              <p className={cn('text-xs font-medium', followUp.status === 'open' ? 'text-warning-fg' : 'text-ink-muted')}>
                {FOLLOW_UP_STATUS[followUp.status]}
                {followUp.declinedReason ? ` · ${followUp.declinedReason}` : ''}
                {revisit ? ` · ${dayWithDate(revisit.date, today)} · ${formatTime(revisit.slot)}` : ''}
              </p>
              {followUp.status === 'open' ? (
                declining ? (
                  <div className="flex flex-col gap-2">
                    <label htmlFor="checkout-decline-reason" className={labelClass}>
                      Why the patient declines <span className="text-critical-fg">*</span>
                    </label>
                    <input
                      id="checkout-decline-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={500}
                      placeholder="Will book from home, say"
                      aria-invalid={reasonTried && !reason.trim()}
                      className={cn(inputClass, reasonTried && !reason.trim() && errorClass)}
                    />
                    <FieldError message={reasonTried && !reason.trim() ? 'Reason required' : null} />
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="ghost" onClick={() => setDeclining(false)} disabled={busy !== null}>
                        Keep it
                      </Button>
                      <Button variant="outline" onClick={onDecline} disabled={busy !== null}>
                        <XCircle className="h-4 w-4" strokeWidth={1.75} />
                        {busy === 'decline' ? 'Declining…' : 'Decline'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => setBooking(true)}>
                      <CalendarPlus className="h-4 w-4" strokeWidth={1.75} />
                      Book the revisit
                    </Button>
                    <Button variant="ghost" onClick={() => setDeclining(true)}>
                      <XCircle className="h-4 w-4" strokeWidth={1.75} />
                      Decline
                    </Button>
                  </div>
                )
              ) : null}
            </>
          )}
        </div>
      </Quadrant>

      <Quadrant id="checkout-summary" step={3} title="After-visit summary" done={summaryOpened}>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-muted">The patient's copy of today's visit, as a PDF.</p>
          <div>
            <Button variant="secondary" onClick={onSummary} disabled={busy !== null}>
              <FileText className="h-4 w-4" strokeWidth={1.75} />
              {busy === 'summary' ? 'Opening…' : 'Print after-visit summary'}
            </Button>
          </div>
          {summaryNote ? <p className="text-xs text-ink-muted">{summaryNote}</p> : null}
        </div>
      </Quadrant>
    </div>,
    confirmBar,
  )
}
