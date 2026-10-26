import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client'
import { listAppointments } from '../../api/generated/endpoints/scheduling/scheduling'
import type { AppointmentSummary } from '../../api/generated/model'
import { DateInput, Field, formatDate, ProblemAlert, Select, Spinner, todayIn, type Problem } from '../../design-system'
import { AppointmentTable } from './AppointmentTable'
import { allPages, useBookableProviders, useBookingReference, withTimeZones } from './reference'

/**
 * The front desk's day (inventory #52): one facility, one date (today in the facility's time zone
 * by default), optionally one provider. Check in, undo a check-in or reschedule from each row.
 */
export function SchedulePage() {
  const reference = useBookingReference()
  const [picked, setPicked] = useState('')
  const facility = reference.facilities?.find((f) => f.id === picked) ?? reference.facilities?.[0]
  const providers = useBookableProviders(facility?.id ?? '')
  const [providerId, setProviderId] = useState('')
  // '' means today at the facility; `null` while the typed date isn't a real one.
  const [date, setDate] = useState<string | null>('')
  const day = date || (facility ? todayIn(facility.timeZone) : '')
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<{ key: string; items: AppointmentSummary[]; timeZone?: string; problem: Problem | null } | null>(null)

  const key = `${facility?.id}|${day}|${providerId}|${version}`
  useEffect(() => {
    if (!facility || !day) return
    let current = true
    // The list for one facility carries that facility's zone (AppointmentList.timeZone).
    let timeZone: string | undefined
    allPages(async (cursor) => {
      const res = await listAppointments({ facilityId: facility.id, date: day, ...(providerId ? { providerId } : {}), limit: 100, ...(cursor ? { cursor } : {}) })
      if (res.status !== 200) return null
      timeZone ??= res.data.timeZone
      return res.data
    })
      .then((items) => {
        if (current) setResult({ key, items, timeZone: timeZone ?? facility.timeZone, problem: null })
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError) setResult({ key, items: [], problem: error.problem })
        else throw error
      })
    return () => {
      current = false
    }
  }, [key, facility, day, providerId])

  const shown = result?.key === key ? result : null

  return (
    <section aria-labelledby="schedule-title" className="space-y-6">
      <h1 id="schedule-title" className="text-2xl font-semibold text-ink">
        Schedule
      </h1>
      {reference.problem ? <ProblemAlert problem={reference.problem} /> : null}
      {!reference.facilities ? (
        <Spinner label="Loading facilities" />
      ) : reference.facilities.length === 0 ? (
        <p className="text-ink-muted">You aren’t assigned to any facility you can book at.</p>
      ) : (
        <>
          <div className="grid gap-4 rounded-xl border border-border bg-surface-1 p-5 md:grid-cols-3">
            <Field label="Facility">
              {(p) => (
                <Select
                  {...p}
                  value={facility?.id ?? ''}
                  onChange={(e) => {
                    setPicked(e.target.value)
                    setProviderId('')
                  }}
                >
                  {reference.facilities!.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Date" hint="MM/DD/YYYY; empty for today" error={date === null ? 'Enter the date as MM/DD/YYYY.' : undefined}>
              {(p) => <DateInput {...p} value="" onValueChange={setDate} />}
            </Field>
            <Field label="Provider">
              {(p) => (
                <Select {...p} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">All providers</option>
                  {(providers ?? []).map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {!shown ? (
            day ? <Spinner label="Loading appointments" /> : null
          ) : shown.problem ? (
            <ProblemAlert problem={shown.problem} />
          ) : (
            <AppointmentTable
              caption={`${facility?.name ?? ''}, ${formatDate(day)}: ${shown.items.length} ${shown.items.length === 1 ? 'appointment' : 'appointments'}`}
              appointments={withTimeZones(shown.items, reference.facilities, shown.timeZone)}
              view="day"
              onChanged={() => setVersion((v) => v + 1)}
              emptyTitle="No appointments this day"
            />
          )}
        </>
      )}
    </section>
  )
}
