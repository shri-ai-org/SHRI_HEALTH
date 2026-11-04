// Scheduling on the SHRI_HEALTH API: who and when can be booked, the bookings, and check-in.
//
// As with patients (shri-health/patients.ts), every result is reconciled into the store and the screens
// keep their selectors. The contract's doctors, free times and bookings become Care Entry's
// providers, `serverSlots` and appointments; a server provider's slot grid is the server's free
// times plus its bookings (domain/selectors.getDoctorSchedule).
//
// Field mapping, Care Entry ⇄ contract:
//   Provider.providerId    ⇐ BookableProvider.id;  name ⇐ displayName
//   Provider.department    ⇐ specialties[0] (the contract has no departments)
//   consultationType       ⇐ whether any appointment type is `telehealth`
//   Appointment.date/slot  ⇄ startAt, shown in the facility's time zone (SHRI_HEALTH D40)
//   Appointment.mode       ⇄ the appointment type: In person → the first non-telehealth type,
//                            Teleconsult → the first telehealth type
//   Appointment.reason     ⇄ reasonForVisit
//   Appointment.status     ⇐ status: booked and arrived → Confirmed (the contract takes no payment
//                            before a visit), checked-in → Checked-in, fulfilled → Completed,
//                            cancelled → Cancelled, noshow → No-show
//   facility               ⇐ the first bookable facility (Care Entry has no facility choice)
//   queue token            ⇐ never (the contract has no tokens; the token stays Care Entry's own)
import {
  bookAppointment as apiBookAppointment,
  cancelAppointment as apiCancelAppointment,
  checkInAppointment as apiCheckInAppointment,
  listAppointments as apiListAppointments,
  listBookableAppointmentTypes as apiListBookableAppointmentTypes,
  listBookableFacilities as apiListBookableFacilities,
  listBookableProviders as apiListBookableProviders,
  listSlots as apiListSlots,
  recordVisitStatus as apiRecordVisitStatus,
  undoCheckIn as apiUndoCheckIn,
} from '../../src/api/generated/endpoints/scheduling/scheduling'
import type {
  Appointment as ApiAppointment,
  AppointmentSummary,
  BookableAppointmentType,
  BookableFacility,
  BookableProvider,
} from '../../src/api/generated/model'
import { newIdempotencyKey } from './client'
import { loadCandidates } from './patients'
import { getState, setState } from '../src/domain/store'
import { addDaysToKey } from '../src/domain/selectors'
import { todayKey } from '../src/domain/time'
import { formatDateKey } from '../src/utils/dates'
import type { Appointment, AppointmentStatus, ConsultMode, UnavailableParty } from '../src/types/appointment'
import type { Provider } from '../src/types/doctor'

const STATUS_FROM_API: Record<string, AppointmentStatus> = {
  booked: 'Confirmed',
  arrived: 'Confirmed',
  'checked-in': 'Checked-in',
  fulfilled: 'Completed',
  cancelled: 'Cancelled',
  noshow: 'No-show',
}

/** What the booking screens need from the server, loaded once per page open. */
interface Bookable {
  facility: BookableFacility
  types: BookableAppointmentType[]
}

let bookable: Promise<Bookable> | null = null
/** The appointment types, once loaded (for the mode of a booking). */
let bookableTypes: BookableAppointmentType[] = []
/** The server's exact start of each free time shown, by `providerId|date|slot`. */
const startAtBySlot = new Map<string, string>()

/** `startAt` as the facility's date and "HH:MM" (SHRI_HEALTH D40: appointments show in facility time). */
export function facilityTime(startAt: string, timeZone: string): { date: string; slot: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(startAt))
      .map((p) => [p.type, p.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, slot: `${parts.hour}:${parts.minute}` }
}

function typeFor(mode: ConsultMode): BookableAppointmentType | null {
  return bookableTypes.find((t) => Boolean(t.telehealth) === (mode === 'Teleconsult')) ?? null
}

function fromProvider(p: BookableProvider, types: BookableAppointmentType[], slotMinutes: number): Provider {
  const tele = types.some((t) => t.telehealth)
  const inPerson = types.some((t) => !t.telehealth)
  const specialty = p.specialties?.[0] ?? 'General Medicine'
  return {
    providerId: p.id,
    name: p.displayName,
    gender: 'Other',
    dateOfBirth: null,
    mobile: '',
    email: null,
    department: specialty,
    specialty,
    qualification: null,
    registrationNumber: '',
    experienceYears: 0,
    employeeId: '',
    consultationType: tele && inPerson ? 'Outpatient + Teleconsult' : tele ? 'Teleconsult only' : 'Outpatient',
    consultationFee: 0,
    room: null,
    loginEmail: null,
    role: 'Consultant',
    status: 'Active',
    // Only the slot length is used: a server provider's times come from the server (serverSlots).
    schedule: { workingDays: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59', slotMinutes, breaks: [] },
    createdAt: Date.now(),
  }
}

function fromAppointment(a: AppointmentSummary | ApiAppointment, timeZone: string, existing: Appointment | undefined): Appointment {
  const { date, slot } = facilityTime(a.startAt, timeZone)
  const provider = getState().providers.find((p) => p.providerId === a.provider.id)
  const tele = bookableTypes.find((t) => t.id === a.appointmentType.id)?.telehealth ?? false
  const cancellation = 'cancellation' in a ? a.cancellation : undefined
  return {
    appointmentId: a.id,
    patientId: a.patient.id,
    providerId: a.provider.id,
    department: provider?.department ?? 'General Medicine',
    date,
    slot,
    status: STATUS_FROM_API[a.status] ?? 'Confirmed',
    // The visit and token are Care Entry's own (written by its check-in), so a refresh keeps them.
    visitId: existing?.visitId ?? null,
    reason: a.reasonForVisit ?? null,
    mode: tele ? 'Teleconsult' : 'In person',
    createdAt: existing?.createdAt ?? ('createdAt' in a ? Date.parse(a.createdAt) : Date.now()),
    cancelledAt: cancellation ? Date.parse(cancellation.cancelledAt) : null,
    cancelledBy: cancellation ? 'Patient' : null,
    cancelReason: cancellation?.reasonText ?? null,
    reschedules: existing?.reschedules ?? [],
    ...(a.visitStatus ? { serverVisitStatus: a.visitStatus } : {}),
  }
}

function reconcileAppointments(items: (AppointmentSummary | ApiAppointment)[], timeZone: string): Appointment[] {
  const byId = new Map(getState().appointments.map((a) => [a.appointmentId, a]))
  const mapped = items.map((a) => fromAppointment(a, timeZone, byId.get(a.id)))
  if (mapped.length === 0) return mapped
  setState((state) => {
    const next = new Map(state.appointments.map((a) => [a.appointmentId, a]))
    for (const a of mapped) next.set(a.appointmentId, a)
    return { ...state, appointments: [...next.values()] }
  })
  return mapped
}

/** Loaded once and shared by every caller (a failure is forgotten, so the next call tries again). */
function loadBookable(): Promise<Bookable> {
  bookable ??= fetchBookable().catch((err: unknown) => {
    bookable = null
    throw err
  })
  return bookable
}

async function fetchBookable(): Promise<Bookable> {
  const facilities = await apiListBookableFacilities({ limit: 100 })
  const facility = facilities.status === 200 ? facilities.data.items[0] : undefined
  if (!facility) throw new Error('No facility can be booked.')
  const [providers, types] = await Promise.all([apiListBookableProviders({ facilityId: facility.id, limit: 100 }), apiListBookableAppointmentTypes({ limit: 100 })])
  const typeItems = types.status === 200 ? types.data.items : []
  bookableTypes = typeItems
  const slotMinutes = typeItems.find((t) => !t.telehealth)?.defaultDurationMinutes ?? 15
  const incoming = providers.status === 200 ? providers.data.items.map((p) => fromProvider(p, typeItems, slotMinutes)) : []
  setState((state) => {
    const byId = new Map(state.providers.map((p) => [p.providerId, p]))
    for (const p of incoming) byId.set(p.providerId, p)
    return {
      ...state,
      providers: [...byId.values()],
      serverSlots: { ...state.serverSlots, ...Object.fromEntries(incoming.map((p) => [p.providerId, state.serverSlots?.[p.providerId] ?? {}])) },
    }
  })
  return { facility, types: typeItems }
}

/** The facility's bookings from `from` for `days` days, with their patients' summaries. */
export async function loadAppointments(from: string, days: number): Promise<Appointment[]> {
  const { facility } = await loadBookable()
  const items: AppointmentSummary[] = []
  let cursor: string | undefined
  do {
    const res = await apiListAppointments({ facilityId: facility.id, dateFrom: from, dateTo: addDaysToKey(from, days - 1), limit: 100, ...(cursor ? { cursor } : {}) })
    if (res.status !== 200) break
    items.push(...res.data.items)
    cursor = res.data.nextCursor
  } while (cursor && items.length < 1000)
  // The booking carries the patient's name only; the summaries add the MRN, age and sex (D54).
  const known = new Set(getState().patients.map((p) => p.patientId))
  const missing = [...new Set(items.map((a) => a.patient.id))].filter((id) => !known.has(id))
  for (let i = 0; i < missing.length; i += 50) await loadCandidates(missing.slice(i, i + 50))
  return reconcileAppointments(items, facility.timeZone)
}

/** The doctors, their free times for `days` days from `from`, and the bookings in that range. */
export async function loadSchedule(from: string, days: number): Promise<void> {
  const { facility } = await loadBookable()
  const dates = Array.from({ length: days }, (_, i) => addDaysToKey(from, i))
  const perDay = await Promise.all(
    dates.map(async (date) => {
      const res = await apiListSlots({ date, facilityId: facility.id, limit: 100 })
      return res.status === 200 ? res.data.items : []
    }),
  )
  const slots: Record<string, Record<string, string[]>> = {}
  for (const slot of perDay.flat()) {
    const { date, slot: label } = facilityTime(slot.startAt, facility.timeZone)
    const byDate = (slots[slot.providerId] ??= {})
    ;(byDate[date] ??= []).push(label)
    startAtBySlot.set(`${slot.providerId}|${date}|${label}`, slot.startAt)
  }
  setState((state) => {
    const serverSlots = { ...state.serverSlots }
    for (const providerId of Object.keys(serverSlots)) {
      serverSlots[providerId] = { ...serverSlots[providerId] }
      for (const date of dates) serverSlots[providerId]![date] = slots[providerId]?.[date] ?? []
    }
    return { ...state, serverSlots }
  })
  await loadAppointments(from, days)
}

/** Is this one of the server's doctors (booked through the API)? */
export function isServerProvider(providerId: string): boolean {
  return Boolean(getState().serverSlots?.[providerId])
}

export interface BookOnServerInput {
  patientId: string
  providerId: string
  date: string
  slot: string
  mode: ConsultMode
  reason?: string
}

/** Books on the server and puts the booking in the store. `key` is this attempt's Idempotency-Key. */
export async function bookOnServer(input: BookOnServerInput, key: string = newIdempotencyKey()): Promise<Appointment> {
  const { facility } = await loadBookable()
  const startAt = startAtBySlot.get(`${input.providerId}|${input.date}|${input.slot}`)
  if (!startAt) throw new Error('That time is no longer offered — choose another time.')
  const type = typeFor(input.mode)
  if (!type) throw new Error(`No appointment type allows ${input.mode === 'Teleconsult' ? 'a teleconsult' : 'an in-person visit'}.`)
  const res = await apiBookAppointment(
    {
      patientId: input.patientId,
      providerId: input.providerId,
      facilityId: facility.id,
      appointmentTypeId: type.id,
      startAt,
      ...(input.reason ? { reasonForVisit: input.reason } : {}),
    },
    { 'Idempotency-Key': key },
  )
  if (res.status !== 201) throw new Error('The booking did not complete')
  // The time is taken now: off the free list, onto the bookings.
  setState((state) => {
    const byDate = state.serverSlots?.[input.providerId]
    if (!byDate) return state
    return { ...state, serverSlots: { ...state.serverSlots, [input.providerId]: { ...byDate, [input.date]: (byDate[input.date] ?? []).filter((s) => s !== input.slot) } } }
  })
  return reconcileAppointments([res.data], facility.timeZone)[0]!
}

/** Is this booking on the server (an opaque UUID, not one of Care Entry's own `apt-…` ids)? */
export function isServerAppointment(appointmentId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appointmentId)
}

/** Checks in on the server (self-pay: Care Entry records no insurance yet), then updates the booking. */
export async function checkInOnServer(appointmentId: string, key: string = newIdempotencyKey()): Promise<void> {
  // Care Entry's check-in that follows takes only today's bookings: say so before the server is asked.
  const booked = getState().appointments.find((a) => a.appointmentId === appointmentId)
  if (booked && booked.date !== todayKey()) throw new Error(`This booking is for ${formatDateKey(booked.date)} — check the patient in on that day.`)
  const { facility } = await loadBookable()
  const res = await apiCheckInAppointment(appointmentId, { 'Idempotency-Key': key }, { selfPay: true })
  if (res.status !== 200) throw new Error('The check-in did not complete')
  // Care Entry's own check-in (domain/actions) then adds the visit and the token, so the booking
  // goes back to Confirmed here for it to move on.
  reconcileAppointments([{ ...res.data.appointment, status: 'booked' }], facility.timeZone)
}

/** Takes back a check-in on the server. The contract asks for a reason. */
export async function undoCheckInOnServer(appointmentId: string, reason: string): Promise<void> {
  const res = await apiUndoCheckIn(appointmentId, { reason })
  if (res.status !== 200) throw new Error('The check-in could not be undone')
}

/** Marks a no-show on the server (`noshow` through the visit-status action); the store follows. */
export async function markNoShowOnServer(appointmentId: string): Promise<void> {
  const res = await apiRecordVisitStatus(appointmentId, { status: 'noshow' })
  if (res.status !== 200) throw new Error('The no-show could not be recorded')
}

/** Cancels on the server: who can't make it becomes the HL7 reason code (`pat` or `prov`), the note its text. */
export async function cancelOnServer(appointmentId: string, by: UnavailableParty, note: string): Promise<void> {
  const { facility } = await loadBookable()
  const res = await apiCancelAppointment(appointmentId, { reasonCode: by === 'Doctor' ? 'prov' : 'pat', ...(note.trim() ? { reasonText: note.trim() } : {}) })
  if (res.status !== 200) throw new Error('The booking could not be cancelled')
  reconcileAppointments([res.data], facility.timeZone)
}
