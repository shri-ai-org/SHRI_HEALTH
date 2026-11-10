// SHRI_HEALTH data layer: src/data/format.ts with the real clock and the clinic's time (D40).
// - Clinic time: every time the API gives (an instant) becomes `clinicDate(…)`, a Date whose local
//   fields are the facility's wall-clock time. The screens' own formatting (src/data/format.ts,
//   date-fns) reads local fields, so it then shows the clinic's time and day, whatever the
//   browser's zone (the front office does the same with care-entry-connect's clinic clock).
//   main.tsx reads the facility's zone first with SHRI_API=real (loadClinic in ./opd.ts).
// - NOW: the mock's is fixed at "Mon 21 Sep 2026, 08:40 IST"; with real visits that makes every
//   wait wrong. Here it is the clinic's time when the screen's data was last read (an ES module
//   binding, so importers see each refresh).
// - Times: 12-hour U.S. time ("1:20 PM") with the API; the sample screens keep their 24-hour format.
export { formatDate, formatDateTime, formatElapsed } from '@/data/format'

let facilityZone: string | undefined

/** An instant as a Date whose local fields are the facility's wall-clock time; as is without a zone. */
export function clinicDate(at: Date | string): Date {
  const d = typeof at === 'string' ? new Date(at) : at
  if (!facilityZone) return d
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: facilityZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  return new Date(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
}

/** The clinic's wall-clock now. */
export function clinicNow(): Date {
  return clinicDate(new Date())
}

export let NOW = new Date()

/** Moves NOW to the present: called whenever the screen's data is read again. */
export function tick(): void {
  NOW = clinicNow()
}

/** The facility's IANA time zone, from the screen's data (BookableFacility.timeZone). */
export function setFacilityTimeZone(zone: string): void {
  facilityZone = zone
  tick()
}

/** `14:30`: a clinic-time Date as it reads, an instant (string) in the clinic's time zone. */
const REAL_API = typeof __SHRI_REAL_API__ !== 'undefined' && __SHRI_REAL_API__

export function formatTime(d: Date | string): string {
  const date = typeof d === 'string' ? clinicDate(d) : d
  return REAL_API
    ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(date)
    : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}
