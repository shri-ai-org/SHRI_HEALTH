import { describe, expect, it } from 'vitest'

import type { LabAnalyte, LabReport } from '../../../shri-health/results'
import { labSeries, rangeLine, trendSummary, axisDay, spacedLabels } from './labTrends'
import { unitText } from '../../../shri-health/results'

// Synthetic values only, shaped as shri-health/results.ts gives them (newest report first).
const analyte = (name: string, value: number, extra: Partial<LabAnalyte> = {}): LabAnalyte => ({
  id: `${name}-${value}`,
  name,
  value: String(value),
  unit: '%',
  numeric: value,
  low: 4,
  high: 5.6,
  range: '4–5.6 %',
  outside: false,
  ...extra,
})
const report = (collectedAt: string | undefined, analytes: LabAnalyte[], issuedAt?: string): LabReport => ({
  id: `r-${collectedAt ?? issuedAt}`,
  name: 'Panel',
  status: 'final',
  collectedAt,
  issuedAt,
  analytes,
})
const day = (at: string) => at.slice(0, 10)

describe('labSeries', () => {
  const reports = [
    report('2026-09-15T15:00:00Z', [analyte('Hemoglobin A1c', 7.1, { flag: '↑ High', outside: true }), analyte('Urine color', NaN, { numeric: undefined, value: 'Yellow' })]),
    report('2026-06-10T15:00:00Z', [analyte('Hemoglobin A1c', 7.6, { flag: '↑ High', outside: true }), analyte('Glucose', 92, { unit: 'mg/dL', low: 70, high: 99 })]),
    report(undefined, [analyte('Hemoglobin A1c', 8.2)], '2026-03-03T18:00:00Z'),
  ]

  it('groups each numeric test into one series, oldest first, dated by collection or issue', () => {
    const series = labSeries(reports)
    expect(series.map((s) => s.name)).toEqual(['Hemoglobin A1c', 'Glucose'])
    const a1c = series[0]
    expect(a1c.readings.map((r) => r.value)).toEqual([8.2, 7.6, 7.1])
    expect(a1c.readings[0].at).toBe('2026-03-03T18:00:00Z')
    expect(series[1].readings).toHaveLength(1)
  })

  it('leaves text results out', () => {
    expect(labSeries(reports).some((s) => s.name === 'Urine color')).toBe(false)
  })

  it('keeps the latest range for the band', () => {
    const a1c = labSeries(reports)[0]
    expect([a1c.low, a1c.high]).toEqual([4, 5.6])
  })

  it('flags a reading by the lab, or by the range when the lab gives none', () => {
    const a1c = labSeries(reports)[0]
    // 8.2 has no interpretation from the lab, but is above 5.6.
    expect(a1c.readings.map((r) => r.flag)).toEqual(['high', 'high', 'high'])
    const normal = labSeries([report('2026-01-01T00:00:00Z', [analyte('Hemoglobin A1c', 5.2, { flag: 'Normal' })])])[0]
    expect(normal.readings[0].flag).toBeUndefined()
  })

  it('keeps tests with the same name but a different unit apart', () => {
    const series = labSeries([report('2026-01-01T00:00:00Z', [analyte('Glucose', 92, { unit: 'mg/dL' }), analyte('Glucose', 5.1, { unit: 'mmol/L' })])])
    expect(series).toHaveLength(2)
  })
})

describe('the words beside the graph', () => {
  it('says high with the limit, and summarizes the trend', () => {
    const a1c = labSeries([
      report('2026-09-15T15:00:00Z', [analyte('Hemoglobin A1c', 7.2, { flag: '↑ High' })]),
      report('2026-03-03T15:00:00Z', [analyte('Hemoglobin A1c', 7.9, { flag: '↑ High' })]),
    ])[0]
    expect(rangeLine(a1c)).toBe('High (above 5.6)')
    expect(trendSummary(a1c, day)).toBe('Latest 7.2 %, high; 2 results since 2026-03-03')
  })

  it('says low, critical and within range', () => {
    const one = (extra: Partial<LabAnalyte>, value: number) => labSeries([report('2026-01-01T00:00:00Z', [analyte('Test', value, extra)])])[0]
    expect(rangeLine(one({ flag: '↓ Low' }, 3.1))).toBe('Low (below 4)')
    expect(rangeLine(one({ flag: '↑↑ Critical high' }, 12))).toBe('Critical high (above 5.6)')
    expect(rangeLine(one({ flag: 'Normal' }, 5))).toBe('Within range (4–5.6)')
    expect(rangeLine(one({ low: undefined, high: undefined }, 5))).toBe('No reference range')
  })
})

describe('the trend chart x-axis (audit issue 3)', () => {
  it('writes whole US dates, never a cut one', () => {
    const d = new Date(2025, 10, 18, 9, 30)
    expect(axisDay(d, false, true)).toBe('Nov 18')
    expect(axisDay(d, true, true)).toBe('Nov 2025')
    expect(axisDay(new Date(2026, 0, 6), true, true)).toBe('Jan 2026')
    expect(axisDay(d, true, true)).not.toMatch(/^\d/)
  })
})

describe('units as people write them (audit issue 4)', () => {
  it('turns UCUM annotations into plain text', () => {
    expect(unitText('mL/min/{1.73_m2}')).toBe('mL/min/1.73 m²')
    expect(unitText('mg/dL')).toBe('mg/dL')
  })
})

describe('x-axis labels that fit (audit issue 3, at 390)', () => {
  it('keeps the first and last, and a middle label only with room on both sides', () => {
    expect(spacedLabels([0, 50, 100, 150, 200, 250, 300], 60)).toEqual([0, 2, 4, 6])
    expect(spacedLabels([0, 20, 40, 60, 80, 100, 120], 60)).toEqual([0, 3, 6])
    expect(spacedLabels([0, 300], 60)).toEqual([0, 1])
    expect(spacedLabels([0], 60)).toEqual([0])
  })
})
