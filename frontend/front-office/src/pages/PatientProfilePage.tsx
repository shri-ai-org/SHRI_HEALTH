import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { UserRound } from 'lucide-react'
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion'
import { cn } from '../utils/cn'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardBody } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { PatientHeader } from '../components/patient/PatientHeader'
import { PatientTimeline } from '../components/patient/PatientTimeline'
import { PatientBillingCard } from '../components/patient/PatientBillingCard'
import { CurrentAdmissionCard } from '../components/patient/CurrentAdmissionCard'
import { AbhaRecordsCard } from '../components/patient/AbhaRecordsCard'
import { BookingDialog } from '../components/appointment/BookingDialog'
import { useStoreValue } from '../hooks/useStore'
import { useNow } from '../hooks/useNow'
import { useCountPatientOpen } from '../hooks/useCountPatientOpen'
import { useFlow } from '../flows/useFlow'
import { getAppointmentById, getPatientById, getToday } from '../domain/selectors'
import { getState } from '../domain/store'
import { cancelAppointment } from '../domain/actions'
import { useToast } from '../hooks/useToast'
import { getPatientHeader, getPatientTimeline } from '../domain/patientSelectors'

/**
 * The patient's hub. Everything the front desk does for a patient starts
 * here — Schedule, Admit or Discharge, Billing — and runs
 * over this page, which is back the moment the task is done. Deliberately
 * non-clinical: identity, contact, money, where they are admitted, and what
 * has happened at the desk.
 */
export function PatientProfilePage() {
  const { uhid } = useParams<{ uhid: string }>()
  const navigate = useNavigate()
  const { openFlow } = useFlow()
  const { notify } = useToast()
  const now = useNow(60000)
  const today = useStoreValue(getToday)

  const patient = useStoreValue(getPatientById, uhid ?? '')
  useCountPatientOpen(patient?.patientId)
  const header = useStoreValue(getPatientHeader, uhid ?? '', now)
  const timeline = useStoreValue(getPatientTimeline, uhid ?? '')
  // The paid booking whose cancel dialog is open (who can't make it decides any refund).
  const [cancelling, setCancelling] = useState<string | null>(null)
  // Payment History is shown on demand; the timeline has the page to itself otherwise.
  const [paymentsOpen, setPaymentsOpen] = useState(false)

  // Nothing paid yet, so nothing to refund: cancelled at once, its bill withdrawn.
  function cancelUnpaid(appointmentId: string) {
    try {
      cancelAppointment({ appointmentId, by: 'Patient', note: 'Cancelled at the desk before payment' })
      notify('Appointment cancelled')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), { tone: 'error' })
    }
  }

  if (!patient) {
    return (
      <div>
        <PageHeader title="Patient not found" />
        <div className="mt-5 sm:mt-6">
          <Card accentTone="teal" className="max-w-xl">
            <CardBody>
              <EmptyState
                icon={UserRound}
                title="No such patient"
                action={<Button size="sm" onClick={() => navigate('/patients')}>Patients</Button>}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    )
  }


  const hasAbha = Boolean(patient.abhaId)
  const twoColumns = paymentsOpen || hasAbha

  return (
    <div>
      <PatientHeader
        patient={patient}
        summary={header}
        actions={{
          schedule: () => openFlow('schedule', { uhid: patient.uhid }),
          admit: () => openFlow('admit', { uhid: patient.uhid }),
          discharge: () => openFlow('discharge', { uhid: patient.uhid }),
          togglePayments: () => setPaymentsOpen((open) => !open),
        }}
        paymentsOpen={paymentsOpen}
      />

      {/* The timeline (with the admission, when there is one) sits in the centre. Payment History
          opens on demand from the header: the timeline slides left and the bills open on the right. */}
      {/* The timeline (with the admission, when there is one) on the left. On the right: the ABHA
          records, when an ABHA is linked — and Payment History, opened from the header, above them,
          pushing the records down; closing it brings them back up. With neither, the timeline is centred. */}
      <LayoutGroup>
        <div className={cn('mt-4 grid grid-cols-1 items-start gap-6 sm:mt-5', twoColumns && 'xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]')}>
          <motion.div layout transition={{ duration: 0.28, ease: 'easeOut' }} className={cn('flex min-w-0 flex-col gap-6', !twoColumns && 'mx-auto w-full max-w-4xl')}>
            {header.admission ? <CurrentAdmissionCard admission={header.admission} now={now} /> : null}
            <PatientTimeline
              timeline={timeline}
              today={today}
              onReschedule={(appointmentId, unpaid) =>
                // Unpaid: simply pick another time — the new booking replaces this one. Paid: the reschedule flow.
                unpaid
                  ? openFlow('schedule', { uhid: patient.uhid, dept: getAppointmentById(getState(), appointmentId)?.department, appointment: appointmentId })
                  : openFlow('reschedule', { appointment: appointmentId })
              }
              onCancel={(appointmentId, unpaid) => (unpaid ? cancelUnpaid(appointmentId) : setCancelling(appointmentId))}
            />
          </motion.div>
          {twoColumns ? (
            <div className="flex min-w-0 flex-col gap-6">
              <AnimatePresence initial={false}>
                {paymentsOpen ? (
                  <motion.div
                    key="payments"
                    layout
                    className="min-w-0"
                    initial={{ opacity: 0, x: 40 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 40 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    <PatientBillingCard patientId={patient.patientId} due={header.payment.due} onClose={() => setPaymentsOpen(false)} />
                  </motion.div>
                ) : null}
              </AnimatePresence>
              {/* Simulated ABHA records — only for a patient with an ABHA linked; keyed so another patient starts afresh. */}
              {hasAbha ? (
                <motion.div layout transition={{ duration: 0.28, ease: 'easeOut' }} className="min-w-0">
                  <AbhaRecordsCard key={patient.patientId} patient={patient} today={today} />
                </motion.div>
              ) : null}
            </div>
          ) : null}
        </div>
      </LayoutGroup>

      {cancelling ? (
        <BookingDialog
          key={cancelling}
          appointmentId={cancelling}
          startWith="cancel"
          onClose={() => setCancelling(null)}
          onReschedule={(appointmentId) => {
            setCancelling(null)
            openFlow('reschedule', { appointment: appointmentId })
          }}
        />
      ) : null}
    </div>
  )
}
