import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../api/client'
import { todayIn, ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { json, problem, serve } from '../../test/fakeServer'
import { PatientAppointmentsPanel } from './PatientAppointmentsPanel'
import { SchedulePage } from './SchedulePage'

// Synthetic data only.
const TZ = 'America/Chicago'
const facility = { id: '00000000-0000-4000-8000-0000000003f1', code: 'MAIN', name: 'Test Main Clinic', timeZone: TZ }
const type = { id: '00000000-0000-4000-8000-0000000003a1', code: 'FU', name: 'Follow-up', defaultDurationMinutes: 20 }
const provider = { id: '00000000-0000-4000-8000-0000000003b1', displayName: 'Dr. Test Provider', facilityIds: [facility.id] }
const patientId = '00000000-0000-4000-8000-0000000000aa'

// "Today" in the facility's zone, whatever the machine's clock says.
const now = new Date()
const today = todayIn(TZ, now)
// Starts now, so it is on today's schedule even just before midnight.
const later = now.toISOString()

const appt = (n: number, extra: object = {}) => ({
  id: `00000000-0000-4000-8000-0000000004a${n}`,
  patient: { id: patientId, displayName: `Testperson${n}, Ana` },
  provider: { id: provider.id, displayName: provider.displayName },
  facilityId: facility.id,
  appointmentType: { id: type.id, name: type.name },
  status: 'booked',
  startAt: later,
  endAt: new Date(now.getTime() + 20 * 60_000).toISOString(),
  ...extra,
})

const REFERENCE = {
  'GET /api/v1/booking/facilities?limit=100': [() => json(200, { items: [facility] })],
  'GET /api/v1/booking/appointment-types?limit=100': [() => json(200, { items: [type] })],
  [`GET /api/v1/booking/providers?facilityId=${facility.id}&limit=100`]: [() => json(200, { items: [provider] })],
}
const DAY = `GET /api/v1/appointments?facilityId=${facility.id}&date=${today}&limit=100`

function renderAt(element: React.ReactNode) {
  const router = createMemoryRouter([{ path: '/', element }, { path: '/patients/:id', element: <p>Patient</p> }], { initialEntries: ['/'] })
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  )
}

beforeEach(() => setCsrfToken('tok'))
afterEach(() => {
  setCsrfToken(null)
  vi.unstubAllGlobals()
})

describe('SchedulePage', () => {
  it("lists today's appointments at the first facility, in facility time, with the actions each allows", async () => {
    serve({
      ...REFERENCE,
      [DAY]: [
        () =>
          json(200, {
            items: [appt(1), appt(2, { status: 'checked-in', visitStatus: 'checked-in' }), appt(3, { status: 'checked-in', visitStatus: 'roomed' }), appt(4, { status: 'cancelled' })],
          }),
      ],
    })
    renderAt(<SchedulePage />)
    const table = await screen.findByRole('table', { name: /Test Main Clinic, .*: 4 appointments/ })
    const rows = within(table).getAllByRole('row')
    expect(within(rows[1]!).getByRole('link', { name: 'Testperson1, Ana' })).toHaveAttribute('href', `/patients/${patientId}`)
    expect(rows[1]).toHaveTextContent('Follow-up · 20 min')
    expect(within(rows[1]!).getByRole('button', { name: 'Check in Testperson1, Ana' })).toBeInTheDocument()
    expect(within(rows[1]!).getByRole('button', { name: 'Reschedule Testperson1, Ana' })).toBeInTheDocument()
    // Checked in, not yet roomed: undo is offered; once roomed it is not (D55).
    expect(within(rows[2]!).getByRole('button', { name: /Undo check-in/ })).toBeInTheDocument()
    expect(within(rows[3]!).queryByRole('button')).not.toBeInTheDocument()
    expect(within(rows[4]!).queryByRole('button')).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('checks in with a required Idempotency-Key and self-pay when chosen, then reloads', async () => {
    const user = userEvent.setup()
    const CHECK_IN = `POST /api/v1/appointments/${appt(1).id}/check-in`
    const server = serve({
      ...REFERENCE,
      [DAY]: [() => json(200, { items: [appt(1)] }), () => json(200, { items: [appt(1, { status: 'checked-in', visitStatus: 'checked-in' })] })],
      [CHECK_IN]: [() => json(200, { appointment: appt(1, { status: 'checked-in' }), encounterId: '00000000-0000-4000-8000-0000000005a1' })],
    })
    renderAt(<SchedulePage />)
    await user.click(await screen.findByRole('button', { name: 'Check in Testperson1, Ana' }))
    const dialog = screen.getByRole('dialog', { name: 'Check in Testperson1, Ana?' })
    await user.click(within(dialog).getByLabelText(/Self-pay visit/))
    await user.click(within(dialog).getByRole('button', { name: 'Check in' }))

    expect(await screen.findByText('Testperson1, Ana checked in')).toBeInTheDocument()
    const [sent] = server.bodies(CHECK_IN)
    expect(sent?.body).toEqual({ selfPay: true })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(await screen.findByRole('button', { name: /Undo check-in/ })).toBeInTheDocument()
  })

  it('shows a refused check-in in plain words and keeps the dialog open', async () => {
    const user = userEvent.setup()
    serve({
      ...REFERENCE,
      [DAY]: [() => json(200, { items: [appt(1)] })],
      [`POST /api/v1/appointments/${appt(1).id}/check-in`]: [() => problem(422, 'business-rule-violation', { requestId: 'r-7' })],
    })
    renderAt(<SchedulePage />)
    await user.click(await screen.findByRole('button', { name: 'Check in Testperson1, Ana' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Check in' }))
    expect(await screen.findByText('Reference: r-7')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('undoes a check-in only with a reason', async () => {
    const user = userEvent.setup()
    const UNDO = `POST /api/v1/appointments/${appt(2).id}/undo-check-in`
    const server = serve({
      ...REFERENCE,
      [DAY]: [() => json(200, { items: [appt(2, { status: 'checked-in', visitStatus: 'checked-in' })] }), () => json(200, { items: [appt(2)] })],
      [UNDO]: [() => json(200, appt(2))],
    })
    renderAt(<SchedulePage />)
    await user.click(await screen.findByRole('button', { name: /Undo check-in of/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText(/Reason/)).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Undo check-in' }))
    expect(within(dialog).getByText('Explain why the check-in was a mistake.')).toBeInTheDocument()
    expect(server.bodies(UNDO)).toHaveLength(0)
    await user.type(within(dialog).getByLabelText(/Reason/), 'Wrong patient checked in')
    await user.click(within(dialog).getByRole('button', { name: 'Undo check-in' }))
    expect(await screen.findByText('Check-in undone')).toBeInTheDocument()
    expect(server.bodies(UNDO)[0]?.body).toEqual({ reason: 'Wrong patient checked in' })
  })

  it('reschedules through the reschedule action with a reason, sending only what changed', async () => {
    const user = userEvent.setup()
    const slotAt = new Date(now.getTime() + 3 * 60 * 60_000).toISOString()
    const MOVE = `POST /api/v1/appointments/${appt(1).id}/reschedule`
    const server = serve({
      ...REFERENCE,
      [DAY]: [() => json(200, { items: [appt(1)] })],
      [`GET /api/v1/slots?date=${today}&facilityId=${facility.id}&appointmentTypeId=${type.id}&providerId=${provider.id}&limit=100`]: [
        () =>
          json(200, {
            items: [
              { startAt: later, endAt: later, providerId: provider.id, facilityId: facility.id, overbook: false },
              { startAt: slotAt, endAt: slotAt, providerId: provider.id, facilityId: facility.id, overbook: false },
            ],
          }),
      ],
      [MOVE]: [() => json(201, { ...appt(5, { startAt: slotAt }), durationMinutes: 20, timeZone: TZ, rescheduledFromId: appt(1).id, createdAt: later, updatedAt: later })],
    })
    renderAt(<SchedulePage />)
    await user.click(await screen.findByRole('button', { name: 'Reschedule Testperson1, Ana' }))
    const dialog = screen.getByRole('dialog', { name: 'Reschedule Testperson1, Ana' })
    // Starts from the current facility, type, provider and day.
    expect(within(dialog).getByLabelText(/^Facility/)).toHaveValue(facility.id)
    // The appointment's own time is shown as current and can't be chosen.
    const [own, other] = await within(dialog).findAllByRole('radio')
    expect(own).toBeDisabled()
    expect(within(dialog).getByText('(current time)')).toBeInTheDocument()
    await user.click(other!)
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule' }))
    expect(within(dialog).getByText('Choose why the appointment is moving.')).toBeInTheDocument()

    await user.selectOptions(within(dialog).getByLabelText(/^Reason/), 'pat')
    expect(await axeViolations()).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule' }))
    expect(await screen.findByText(/^Moved to /)).toBeInTheDocument()
    const [sent] = server.bodies(MOVE)
    expect(sent?.body).toEqual({ startAt: slotAt, reasonCode: 'pat' })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('PatientAppointmentsPanel', () => {
  const tomorrowAt = new Date(now.getTime() + 26 * 60 * 60_000).toISOString()
  const tomorrow = todayIn(TZ, new Date(tomorrowAt))
  const [y, m, d] = tomorrow.split('-')
  const SLOTS = `GET /api/v1/slots?date=${tomorrow}&facilityId=${facility.id}&appointmentTypeId=${type.id}&limit=100`
  const slot = { startAt: tomorrowAt, endAt: tomorrowAt, providerId: provider.id, facilityId: facility.id, overbook: false }

  async function chooseSlot(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Book appointment' }))
    const dialog = screen.getByRole('dialog', { name: 'Book an appointment for Ana Testperson' })
    await user.selectOptions(await within(dialog).findByLabelText(/^Facility/), facility.id)
    await user.selectOptions(within(dialog).getByLabelText(/^Appointment type/), type.id)
    await user.type(within(dialog).getByLabelText(/^Date/), `${m}/${d}/${y}`)
    await user.click(await within(dialog).findByRole('radio'))
    return dialog
  }

  it('books from free times with an Idempotency-Key and lists the new appointment', async () => {
    const user = userEvent.setup()
    const server = serve({
      ...REFERENCE,
      [`GET /api/v1/appointments?patientId=${patientId}&limit=50`]: [() => json(200, { items: [] }), () => json(200, { items: [appt(6, { startAt: tomorrowAt })] })],
      [SLOTS]: [() => json(200, { items: [slot] })],
      'POST /api/v1/appointments': [() => json(201, { ...appt(6, { startAt: tomorrowAt }), durationMinutes: 20, timeZone: TZ, createdAt: later, updatedAt: later })],
    })
    renderAt(<PatientAppointmentsPanel patientId={patientId} patientName="Ana Testperson" />)
    await screen.findByText('No appointments')
    const dialog = await chooseSlot(user)
    await user.type(within(dialog).getByLabelText(/Reason for visit/), 'Follow-up on headaches')
    await user.click(within(dialog).getByRole('button', { name: 'Book appointment' }))

    expect(await screen.findByText(/^Booked for /)).toBeInTheDocument()
    const [sent] = server.bodies('POST /api/v1/appointments')
    expect(sent?.body).toEqual({ patientId, providerId: provider.id, facilityId: facility.id, appointmentTypeId: type.id, startAt: tomorrowAt, reasonForVisit: 'Follow-up on headaches' })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(await screen.findByRole('table', { name: 'Appointments' })).toHaveTextContent('Dr. Test Provider')
  })

  it('reads the free times again after a booking conflict', async () => {
    const user = userEvent.setup()
    const server = serve({
      ...REFERENCE,
      [`GET /api/v1/appointments?patientId=${patientId}&limit=50`]: [() => json(200, { items: [] })],
      [SLOTS]: [() => json(200, { items: [slot] }), () => json(200, { items: [] })],
      'POST /api/v1/appointments': [() => problem(409, 'booking-conflict')],
    })
    renderAt(<PatientAppointmentsPanel patientId={patientId} patientName="Ana Testperson" />)
    await screen.findByText('No appointments')
    const dialog = await chooseSlot(user)
    await user.click(within(dialog).getByRole('button', { name: 'Book appointment' }))
    expect(await within(dialog).findByText('Time no longer available')).toBeInTheDocument()
    expect(await within(dialog).findByText('No free times that day')).toBeInTheDocument()
    expect(server.calls().filter((c) => c === SLOTS)).toHaveLength(2)
  })
})
