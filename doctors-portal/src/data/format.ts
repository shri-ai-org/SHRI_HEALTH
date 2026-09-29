/**
 * UI_ATLAS.md §5.4 — the India formatting rules, enforced in one place.
 *
 * These are clinical-safety rules, not locale preferences. The atlas is blunt
 * about the date one: "MM/DD is forbidden everywhere — it is an actual
 * clinical-safety hazard."
 */

/** The fixed reference moment for every screen in the product. */
export const NOW = new Date(2026, 8, 21, 8, 40, 0) // Mon 21 Sep 2026, 08:40 IST

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `21-Sep-2026`. Never MM/DD. */
export function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return `${pad(date.getDate())}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`
}

/** `Mon 21-Sep-2026`. */
export function formatDateLong(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return `${DAYS[date.getDay()]} ${formatDate(date)}`
}

/** `14:30`. §5.4 — 24-hour in every clinical context, never 2:30 PM. */
export function formatTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `21-Sep-2026 14:30`. */
export function formatDateTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return `${formatDate(date)} ${formatTime(date)}`
}

/**
 * Indian lakh/crore grouping: `₹12,45,678`, not `₹1,245,678`.
 * The last three digits group as one, everything above them in pairs.
 */
export function formatRupees(amount: number): string {
  const sign = amount < 0 ? '-' : ''
  const whole = Math.abs(Math.round(amount)).toString()
  if (whole.length <= 3) return `${sign}₹${whole}`
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')
  return `${sign}₹${grouped},${last3}`
}

/**
 * Dashboard short form: `₹12.46 L` / `₹1.25 Cr`.
 * §5.4 — permitted on dashboards, NEVER in an invoice.
 */
export function formatRupeesShort(amount: number): string {
  if (Math.abs(amount) >= 1_00_00_000) return `₹${(amount / 1_00_00_000).toFixed(2)} Cr`
  if (Math.abs(amount) >= 1_00_000) return `₹${(amount / 1_00_000).toFixed(2)} L`
  return formatRupees(amount)
}

/** Elapsed time as a clinical duration: `4h 12m`, `18m`, `2d 3h`. */
export function formatElapsed(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`
  const d = Math.floor(h / 24)
  const hr = h % 24
  return hr ? `${d}d ${hr}h` : `${d}d`
}

/** `mm:ss` for a running stroke clock — tabular figures, fixed width. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

/** Minutes between the fixed moment and an offset, for "12 min ago" copy. */
export function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000)
}

export function minutesAhead(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000)
}

/**
 * §5.4 — "Weights, heights and doses always carry their unit; paediatric doses
 * are per-kg with the weight and its capture time shown beside them."
 */
export function withUnit(value: number | string, unit: string): string {
  return `${value} ${unit}`
}

/** Age and sex as the patient banner renders it: `62/M`. */
export function ageSex(age: number, sex: 'M' | 'F' | 'O'): string {
  return `${age}/${sex}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}
