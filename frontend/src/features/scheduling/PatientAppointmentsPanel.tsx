import { CalendarPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client'
import { listAppointments } from '../../api/generated/endpoints/scheduling/scheduling'
import type { AppointmentSummary } from '../../api/generated/model'
import { Button, ProblemAlert, type Problem } from '../../design-system'
import { AppointmentTable } from './AppointmentTable'
import { BookAppointmentDialog } from './BookAppointmentDialog'
import { useBookingReference, withTimeZones } from './reference'

/** A patient's appointments, with booking and the same actions as the day schedule. */
export function PatientAppointmentsPanel({ patientId, patientName }: { patientId: string; patientName: string }) {
  const [items, setItems] = useState<AppointmentSummary[] | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [booking, setBooking] = useState(false)
  const [version, setVersion] = useState(0)
  const reference = useBookingReference()

  useEffect(() => {
    let current = true
    listAppointments({ patientId, limit: 50 })
      .then((res) => {
        if (!current || res.status !== 200) return
        setItems(res.data.items)
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
