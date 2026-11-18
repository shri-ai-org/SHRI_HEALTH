// SHRI_HEALTH: a patient's lab values over time, for the Test results tab's trends (LabTrendCard).
// One series per test: the reports' numeric analytes grouped by name and unit (the adapter names
// an analyte from its LOINC coding, so one name is one code here), oldest first, dated by when the
// sample was collected (or the report issued). Text results have no series. A reading is flagged by
// the lab's interpretation, or, when the lab gives none, by the reference range.

import { formatDate } from '@/data/format'
import type { LabReport } from '../../../shri-health/results'

export type TrendFlag = 'high' | 'low' | 'critical-high' | 'critical-low' | 'abnormal'

export interface LabReading {
  /** When the sample was collected (or the report issued), as the API gives it. */
  at: string
  value: number
  flag?: TrendFlag
}

export interface LabSeries {
  key: string
  name: string
  unit?: string
  /** The latest reading's reference range. */
  low?: number
  high?: number
  /** Oldest first. */
  readings: LabReading[]
}

/** ClinicalFlag's words (shri-health/results.ts) to the trend's flags. */
const FROM_WORD: Record<string, TrendFlag> = {
  '↑ High': 'high',
  '↓ Low': 'low',
  '↑↑ Critical high': 'critical-high',
  '↓↓ Critical low': 'critical-low',
  Abnormal: 'abnormal',
}

/** The flag in a word, for a label or a tooltip: never colour alone. */
export const FLAG_WORD: Record<TrendFlag, string> = {
  high: 'High',
  low: 'Low',
  'critical-high': 'Critical high',
  'critical-low': 'Critical low',
  abnormal: 'Abnormal',
}

function flagOf(word: string | undefined, value: number, low?: number, high?: number): TrendFlag | undefined {
  if (word !== undefined) return FROM_WORD[word]
  if (high !== undefined && value > high) return 'high'
  if (low !== undefined && value < low) return 'low'
  return undefined
}

/** Every numeric test on the reports as a series, in the order the tests first appear (newest report first). */
export function labSeries(reports: LabReport[]): LabSeries[] {
  type Ranged = LabReading & { low?: number; high?: number }
  const byKey = new Map<string, { name: string; unit?: string; readings: Ranged[] }>()
  for (const r of reports) {
    const at = r.collectedAt ?? r.issuedAt
    if (!at) continue
    for (const a of r.analytes) {
      if (a.numeric === undefined || !Number.isFinite(a.numeric)) continue
      const key = `${a.name}|${a.unit ?? ''}`
      let s = byKey.get(key)
      if (!s) {
        s = { name: a.name, unit: a.unit, readings: [] }
        byKey.set(key, s)
      }
      const flag = flagOf(a.flag, a.numeric, a.low, a.high)
      s.readings.push({ at, value: a.numeric, ...(flag ? { flag } : {}), low: a.low, high: a.high })
    }
  }
  return [...byKey.entries()].map(([key, s]) => {
    const readings = [...s.readings].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))
    const latest = readings[readings.length - 1]
    return {
      key,
      name: s.name,
      unit: s.unit,
      low: latest.low,
      high: latest.high,
      readings: readings.map(({ at, value, flag }) => ({ at, value, ...(flag ? { flag } : {}) })),
    }
  })
}

/** A number as the lab would write it: no trailing zeros, at most three decimals. */
export function formatValue(n: number): string {
  return String(Number(n.toFixed(3)))
}

/** The latest reading against the range in plain words: "High (above 5.7)", "Within range (4–5.6)". */
export function rangeLine(s: LabSeries): string {
  const latest = s.readings[s.readings.length - 1]
  const { low, high } = s
  switch (latest.flag) {
    case 'high':
    case 'critical-high':
      return high !== undefined ? `${FLAG_WORD[latest.flag]} (above ${formatValue(high)})` : FLAG_WORD[latest.flag]
    case 'low':
    case 'critical-low':
      return low !== undefined ? `${FLAG_WORD[latest.flag]} (below ${formatValue(low)})` : FLAG_WORD[latest.flag]
    case 'abnormal':
      return 'Abnormal'
  }
  if (low !== undefined && high !== undefined) return `Within range (${formatValue(low)}–${formatValue(high)})`
  if (high !== undefined) return `Within range (at most ${formatValue(high)})`
  if (low !== undefined) return `Within range (at least ${formatValue(low)})`
  return 'No reference range'
}

/** The graph's text alternative: "Latest 7.2 %, high; 5 results since Mar 3, 2026". */
export function trendSummary(s: LabSeries, day: (at: string) => string): string {
  const latest = s.readings[s.readings.length - 1]
  const unit = s.unit ? ` ${s.unit}` : ''
  const flag = latest.flag ? `, ${FLAG_WORD[latest.flag].toLowerCase()}` : s.low !== undefined || s.high !== undefined ? ', within range' : ''
  return `Latest ${formatValue(latest.value)}${unit}${flag}; ${s.readings.length} results since ${day(s.readings[0].at)}`
}

const REAL_API = typeof __SHRI_REAL_API__ !== 'undefined' && __SHRI_REAL_API__

/**
 * A point's date on the x-axis: the month and year over a year or more, else the day. With the API,
 * U.S. style ("Nov 2025", "Nov 18"), read from the date's own fields (the clinic's day); the sample
 * screens keep cutting their "18-Nov-2025". Never a cut US date ("18, 2025").
 */
export function axisDay(d: Date, long: boolean, realApi: boolean = REAL_API): string {
  if (realApi) return new Intl.DateTimeFormat('en-US', long ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' }).format(d)
  return long ? formatDate(d).slice(3) : formatDate(d).replace(/-\d{4}$/, '')
}
