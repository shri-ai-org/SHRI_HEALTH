// ported from src/screens/m06/S0610.tsx:31-37 (`isDue`) and 55-62 (the
// library: the fixtures, the sets made here, and each promotion laid over).
//
// "Changing a set does not rewrite history. Each version is effective from a
// date" — the old screen said so and its Effective-on date did nothing. Here
// the date is the library as it stood that day: a set made after it is not in
// it, and a promotion dated after it has not happened yet.

import { ORDER_SETS } from '@/data/clinical'
import { NOW, formatDate } from '@/data/format'
import type { CreatedSet } from '@/store/clinical'

export type LibrarySet = Omit<(typeof ORDER_SETS)[number], 'scope'> & { scope: 'Facility-wide' | 'Personal'; createdAt?: string }

/** A review date as the library shows it — the fixtures' `31-Mar-2027`, whichever form it was stored in. */
export function reviewLabel(reviewDue: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(reviewDue) ? formatDate(new Date(`${reviewDue}T00:00:00`)) : reviewDue
}

export function reviewDate(reviewDue: string): Date | undefined {
  if (reviewDue === '—') return undefined
  const d = /^\d{4}-\d{2}-\d{2}$/.test(reviewDue) ? new Date(`${reviewDue}T00:00:00`) : new Date(reviewDue.replace(/(\d+)-(\w+)-(\d+)/, '$2 $1, $3'))
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** A set is due for review once its review date has passed or falls within 30 days. */
export function isDue(reviewDue: string): boolean {
  const d = reviewDate(reviewDue)
  return d !== undefined && d.getTime() - NOW.getTime() < 30 * 24 * 3_600_000
}

/** Whether a proposed review date is after today — a date already past could never be met. */
export function reviewAhead(iso: string): boolean {
  const d = reviewDate(iso)
  return d !== undefined && d.getTime() > NOW.getTime()
}

/** `YYYY-MM-DD` for a date, in the build's own clock's terms. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The library as it stood at the end of `day`. */
export function libraryOn(day: string, created: CreatedSet[], promoted: Record<string, { owner: string; reviewDue: string; at: string }>): LibrarySet[] {
  const end = new Date(`${day}T23:59:59.999`)
  const sets: LibrarySet[] = [...ORDER_SETS, ...created.filter((c) => new Date(c.createdAt) <= end)]
  return sets.map((s) => {
    const p = promoted[s.id]
    return p && new Date(p.at) <= end ? { ...s, scope: 'Facility-wide' as const, owner: p.owner, reviewDue: p.reviewDue } : s
  })
}

// ported from src/screens/m09/S0902.tsx:25-46 — AI-303's adherence report, word
// for word: where care diverged from each pathway this month, and why.
export const PATHWAY_ADHERENCE = [
  {
    pathway: 'Community-acquired pneumonia — adult',
    cases: 142,
    adherence: 0.87,
    divergences: [
      { step: 'Sputum culture within 24h', rate: 0.61, note: 'Most often omitted when the patient cannot expectorate' },
      { step: 'Antibiotic review at 48h', rate: 0.92, note: '' },
      { step: 'Oxygen target documented', rate: 0.78, note: 'Charted as a range rather than a target in most misses' },
    ],
  },
  {
    pathway: 'Sepsis bundle — first hour',
    cases: 88,
    adherence: 0.71,
    divergences: [
      { step: 'Lactate within 1h', rate: 0.64, note: 'Analyser turnaround is the constraint, not the ordering' },
      { step: 'Blood culture before antibiotics', rate: 0.83, note: '' },
      { step: 'Fluids started within 1h', rate: 0.94, note: '' },
    ],
  },
]
