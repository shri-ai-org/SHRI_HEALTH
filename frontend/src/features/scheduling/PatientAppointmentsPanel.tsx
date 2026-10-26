import { CalendarPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client'
import { listAppointments } from '../../api/generated/endpoints/scheduling/scheduling'
import type { AppointmentSummary } from '../../api/generated/model'
import { Alert, Button, ProblemAlert, type Problem } from '../../design-system'
import { AppointmentTable } from './AppointmentTable'
import { BookAppointmentDialog } from './BookAppointmentDialog'
import { allPages, useBookingReference, withTimeZones } from './reference'

/** A patient's appointments, with booking and the same actions as the day schedule. */
export function PatientAppointmentsPanel({ patientId, patientName }: { patientId: string; patientName: string }) {
  const [items, setItems] = useState<AppointmentSummary[] | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [booking, setBooking] = useState(false)
  const [version, setVersion] = useState(0)
  const reference = useBookingReference()

  useEffect(() => {
    let current = true
    allPages(async (cursor) => {
      const res = await listAppointments({ patientId, limit: 100, ...(cursor ? { cursor } : {}) })
      return res.status === 200 ? res.data : null
    })
      .then((all) => {
        if (!current) return
        setItems(all)
        setProblem(null)
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError) setProblem(error.problem)
        else throw error
      })
    return () => {
      current = false
    }
  }, [patientId, version])

  const reload = () => setVersion((v) => v + 1)

  return (
    <section aria-labelledby="appointments-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="appointments-title" className="text-lg font-semibold text-ink">
          Appointments
        </h2>
        <Button variant="outline" icon={<CalendarPlus aria-hidden="true" size={16} />} onClick={() => setBooking(true)}>
          Book appointment
        </Button>
      </div>
      {problem ? <ProblemAlert problem={problem} /> : null}
      {reference.problem ? (
        <Alert tone="warning" title="Facility times unavailable">
          <p>The facility list couldn't be loaded, so times show in UTC and the appointment actions are hidden.</p>
          {reference.problem.requestId ? <p className="mt-1 text-xs opacity-80">Reference: {reference.problem.requestId}</p> : null}
        </Alert>
      ) : null}
      {items && reference.facilities ? <AppointmentTable caption="Appointments" appointments={withTimeZones(items, reference.facilities)} view="patient" onChanged={reload} emptyTitle="No appointments" /> : null}
      {booking ? (
        <BookAppointmentDialog
          patientId={patientId}
          patientName={patientName}
          onClose={() => setBooking(false)}
          onBooked={() => {
            setBooking(false)
            reload()
          }}
        />
      ) : null}
    </section>
  )
}
