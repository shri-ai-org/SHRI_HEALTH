/**
 * Vitals — the readings the snapshot in `clinical.ts` (`VITALS`) was missing,
 * and the history behind every snapshot: four-hourly over the last day for an
 * inpatient, earlier visits for an outpatient. Merged into `VITALS` by
 * `clinical.ts`; the history is read by the Vitals card and the Trend card.
 *
 * The rules every series keeps:
 *   · its last point is the snapshot — the same value at the same time;
 *   · it agrees with the record: Lakshmanan's oxygen doubling at 04:20 and
 *     his NEWS2 rising over four hours, Priya's GCS falling from 15 to 13
 *     overnight, Kavya afebrile for 18 hours, Fatima's weight up 1.6 kg since
 *     her last dialysis, Joseph's pressure held on noradrenaline;
 *   · BP is charted by its systolic value — the snapshot keeps both numbers.
 */

import { minutesAgo } from './format'

export interface VitalRow {
  label: string
  value: string
  flag: 'Normal' | '↑ High' | '↓ Low'
  at: Date
}

export interface VitalSeries {
  /** The snapshot's label, so the two are joined by name. */
  label: string
  unit: string
  /** The normal range, for the Trend card's band. */
  low?: number
  high?: number
  points: { at: Date; value: number }[]
}

const d = (m: number, day: number, h: number, min = 0, y = 2026) => new Date(y, m - 1, day, h, min)

/** Readings four hours apart, the last at `end`. */
function fourHourly(end: Date, values: number[]): { at: Date; value: number }[] {
  return values.map((value, i) => ({
    at: new Date(end.getTime() - (values.length - 1 - i) * 4 * 3_600_000),
    value,
  }))
}

/** Readings the snapshot lacked — appended after the ones already there. */
export const VITALS_EXT: Record<string, VitalRow[]> = {
  // Sunita — 32 weeks, seen this morning
  'SD-P-04': [
    { label: 'BP', value: '118/74 mmHg', flag: 'Normal', at: minutesAgo(45) },
    { label: 'Pulse', value: '88 bpm', flag: 'Normal', at: minutesAgo(45) },
    { label: 'Weight', value: '68 kg', flag: 'Normal', at: minutesAgo(45) },
    {
      label: 'Fundal height',
      value: '32 cm',
      flag: 'Normal',
      at: minutesAgo(45),
    },
    {
      label: 'Fetal heart',
      value: '142 bpm',
      flag: 'Normal',
      at: minutesAgo(45),
    },
  ],
  // Kavya — afebrile 18 hours, for discharge
  'SD-P-06': [
    {
      label: 'Temperature',
      value: '36.9 °C',
      flag: 'Normal',
      at: minutesAgo(40),
    },
    { label: 'Pulse', value: '96 bpm', flag: 'Normal', at: minutesAgo(40) },
    {
      label: 'Respiratory rate',
      value: '20 /min',
      flag: 'Normal',
      at: minutesAgo(40),
    },
    { label: 'SpO₂', value: '99% on air', flag: 'Normal', at: minutesAgo(40) },
    { label: 'Weight', value: '19 kg', flag: 'Normal', at: minutesAgo(40) },
  ],
  // Arjun — teleconsult today; these are from his last visit in person
  'SD-P-10': [
    { label: 'BP', value: '118/76 mmHg', flag: 'Normal', at: d(9, 12, 9, 40) },
    { label: 'Pulse', value: '72 bpm', flag: 'Normal', at: d(9, 12, 9, 40) },
    { label: 'Weight', value: '68 kg', flag: 'Normal', at: d(9, 12, 9, 40) },
    { label: 'BMI', value: '22.4 kg/m²', flag: 'Normal', at: d(9, 12, 9, 40) },
    {
      label: 'Temperature',
      value: '36.7 °C',
      flag: 'Normal',
      at: d(9, 12, 9, 40),
    },
  ],
  'SD-P-02': [
    {
      label: 'Respiratory rate',
      value: '18 /min',
      flag: 'Normal',
      at: minutesAgo(60),
    },
  ],
  'SD-P-09': [
    { label: 'SpO₂', value: '97% on air', flag: 'Normal', at: minutesAgo(90) },
    {
      label: 'Temperature',
      value: '36.7 °C',
      flag: 'Normal',
      at: minutesAgo(90),
    },
  ],
  'SD-P-15': [
    { label: 'SpO₂', value: '99% on air', flag: 'Normal', at: d(9, 9, 10, 5) },
    {
      label: 'Temperature',
      value: '36.6 °C',
      flag: 'Normal',
      at: d(9, 9, 10, 5),
    },
  ],
  'SD-P-16': [
    { label: 'SpO₂', value: '99% on air', flag: 'Normal', at: minutesAgo(72) },
    {
      label: 'Temperature',
      value: '36.8 °C',
      flag: 'Normal',
      at: minutesAgo(72),
    },
  ],
}

const BP = { label: 'BP', unit: 'mmHg systolic', low: 90, high: 140 }
const PULSE = { label: 'Pulse', unit: 'bpm', low: 60, high: 100 }
const SPO2 = { label: 'SpO₂', unit: '%', low: 94, high: 100 }
const TEMP = { label: 'Temperature', unit: '°C', low: 36.1, high: 37.9 }
const RR = { label: 'Respiratory rate', unit: '/min', low: 12, high: 20 }
const GCS = { label: 'GCS', unit: '/15', low: 15, high: 15 }
const WEIGHT = { label: 'Weight', unit: 'kg' }

export const VITALS_HISTORY: Record<string, VitalSeries[]> = {
  // ── Inpatients: four-hourly over the last day
  'SD-P-03': (() => {
    const end = minutesAgo(50)
    return [
      { ...RR, points: fourHourly(end, [20, 20, 22, 22, 22, 24, 26]) },
      { ...SPO2, points: fourHourly(end, [95, 95, 94, 94, 93, 91, 92]) },
      { ...PULSE, points: fourHourly(end, [96, 98, 100, 98, 102, 106, 108]) },
      { ...BP, points: fourHourly(end, [118, 116, 114, 112, 110, 106, 104]) },
      {
        ...TEMP,
        points: fourHourly(end, [38.0, 37.8, 38.2, 38.6, 38.1, 38.6, 38.4]),
      },
    ]
  })(),
  'SD-P-07': (() => {
    const end = minutesAgo(20)
    return [
      { ...RR, points: fourHourly(end, [18, 18, 18, 18, 18, 18, 18]) },
      { ...SPO2, points: fourHourly(end, [95, 95, 96, 94, 94, 93, 94]) },
      {
        ...PULSE,
        points: fourHourly(end, [112, 110, 114, 118, 120, 122, 124]),
      },
      { ...BP, points: fourHourly(end, [94, 92, 90, 88, 90, 88, 86]) },
      {
        ...TEMP,
        points: fourHourly(end, [38.2, 38.0, 38.6, 38.4, 38.8, 39.0, 38.9]),
      },
    ]
  })(),
  'SD-P-02': (() => {
    const end = minutesAgo(60)
    return [
      { ...PULSE, points: fourHourly(end, [96, 94, 92, 90, 90, 88, 88]) },
      { ...BP, points: fourHourly(end, [112, 114, 118, 120, 118, 120, 122]) },
      { ...SPO2, points: fourHourly(end, [94, 95, 95, 96, 96, 96, 96]) },
      {
        ...TEMP,
        points: fourHourly(end, [37.6, 37.4, 37.4, 37.2, 37.3, 37.2, 37.2]),
      },
      { ...RR, points: fourHourly(end, [20, 20, 18, 18, 18, 18, 18]) },
    ]
  })(),
  'SD-P-06': (() => {
    const end = minutesAgo(40)
    return [
      {
        ...TEMP,
        points: fourHourly(end, [38.6, 38.1, 37.3, 37.0, 36.9, 36.8, 36.9]),
      },
      {
        ...PULSE,
        low: 70,
        high: 120,
        points: fourHourly(end, [124, 118, 108, 102, 98, 96, 96]),
      },
      {
        ...RR,
        low: 18,
        high: 30,
        points: fourHourly(end, [24, 24, 22, 22, 20, 20, 20]),
      },
      { ...SPO2, points: fourHourly(end, [98, 98, 99, 99, 99, 99, 99]) },
    ]
  })(),
  // Fatima — outpatient haemodialysis: before and after her last two sessions, and this morning's home readings for the teleconsult
  'SD-P-09': [
    {
      ...BP,
      points: [
        { at: d(9, 17, 13, 50), value: 154 },
        { at: d(9, 17, 18, 0), value: 136 },
        { at: d(9, 19, 13, 50), value: 158 },
        { at: d(9, 19, 18, 0), value: 138 },
        { at: minutesAgo(90), value: 152 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: d(9, 17, 13, 50), value: 55.4 },
        { at: d(9, 17, 18, 0), value: 54.2 },
        { at: d(9, 19, 13, 50), value: 55.2 },
        { at: d(9, 19, 18, 0), value: 54.0 },
        { at: minutesAgo(90), value: 55.6 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: d(9, 17, 13, 50), value: 80 },
        { at: d(9, 19, 13, 50), value: 84 },
        { at: minutesAgo(90), value: 82 },
      ],
    },
  ],
  'SD-P-12': (() => {
    const end = minutesAgo(130)
    return [
      { ...BP, points: fourHourly(end, [162, 158, 154, 152, 150, 150, 148]) },
      { ...PULSE, points: fourHourly(end, [76, 74, 72, 74, 72, 70, 72]) },
      { ...GCS, points: fourHourly(end, [15, 15, 15, 15, 15, 15, 15]) },
      { ...SPO2, points: fourHourly(end, [97, 98, 98, 97, 98, 98, 98]) },
      {
        ...TEMP,
        points: fourHourly(end, [37.0, 36.8, 36.9, 37.1, 36.8, 36.9, 36.9]),
      },
    ]
  })(),
  'SD-P-13': (() => {
    const end = minutesAgo(70)
    return [
      { ...GCS, points: fourHourly(end, [15, 15, 15, 14, 14, 13, 13]) },
      { ...BP, points: fourHourly(end, [168, 166, 170, 162, 166, 160, 164]) },
      { ...PULSE, points: fourHourly(end, [72, 70, 68, 66, 66, 64, 64]) },
      { ...SPO2, points: fourHourly(end, [97, 97, 96, 96, 96, 96, 96]) },
      {
        ...TEMP,
        points: fourHourly(end, [37.2, 37.1, 37.3, 37.2, 37.4, 37.3, 37.4]),
      },
    ]
  })(),

  // ── Outpatients: earlier visits, then today's (or the last) reading
  'SD-P-01': [
    {
      ...WEIGHT,
      points: [
        { at: d(3, 18, 11, 0, 2025), value: 61 },
        { at: d(9, 18, 11, 0, 2025), value: 60 },
        { at: d(3, 14, 10, 30), value: 59 },
        { at: minutesAgo(9), value: 58 },
      ],
    },
    {
      ...BP,
      points: [
        { at: d(3, 18, 11, 0, 2025), value: 120 },
        { at: d(9, 18, 11, 0, 2025), value: 118 },
        { at: d(3, 14, 10, 30), value: 116 },
        { at: minutesAgo(9), value: 118 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: d(3, 18, 11, 0, 2025), value: 68 },
        { at: d(9, 18, 11, 0, 2025), value: 72 },
        { at: d(3, 14, 10, 30), value: 74 },
        { at: minutesAgo(9), value: 76 },
      ],
    },
  ],
  'SD-P-04': [
    {
      ...WEIGHT,
      points: [
        { at: d(7, 20, 10, 0), value: 64.2 },
        { at: d(8, 24, 10, 0), value: 65.4 },
        { at: d(9, 19, 10, 0), value: 67.6 },
        { at: minutesAgo(45), value: 68 },
      ],
    },
    {
      ...BP,
      points: [
        { at: d(7, 20, 10, 0), value: 110 },
        { at: d(8, 24, 10, 0), value: 112 },
        { at: d(9, 19, 10, 0), value: 116 },
        { at: minutesAgo(45), value: 118 },
      ],
    },
    {
      label: 'Fundal height',
      unit: 'cm',
      points: [
        { at: d(7, 20, 10, 0), value: 20 },
        { at: d(8, 24, 10, 0), value: 28 },
        { at: d(9, 19, 10, 0), value: 32 },
        { at: minutesAgo(45), value: 32 },
      ],
    },
    {
      label: 'Fetal heart',
      unit: 'bpm',
      low: 110,
      high: 160,
      points: [
        { at: d(7, 20, 10, 0), value: 150 },
        { at: d(8, 24, 10, 0), value: 144 },
        { at: d(9, 19, 10, 0), value: 140 },
        { at: minutesAgo(45), value: 142 },
      ],
    },
  ],
  'SD-P-10': [
    {
      ...WEIGHT,
      points: [
        { at: d(7, 28, 9, 30), value: 69 },
        { at: d(9, 12, 9, 40), value: 68 },
      ],
    },
    {
      ...BP,
      points: [
        { at: d(7, 28, 9, 30), value: 116 },
        { at: d(9, 12, 9, 40), value: 118 },
      ],
    },
  ],
  'SD-P-11': [
    {
      ...BP,
      points: [
        { at: d(9, 1, 8, 0), value: 142 },
        { at: d(9, 7, 10, 0), value: 138 },
        { at: minutesAgo(12), value: 134 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: d(9, 1, 8, 0), value: 88 },
        { at: d(9, 7, 10, 0), value: 86 },
        { at: minutesAgo(12), value: 84 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: d(9, 1, 8, 0), value: 53 },
        { at: d(9, 7, 10, 0), value: 52.5 },
        { at: minutesAgo(12), value: 52 },
      ],
    },
  ],
  'SD-P-15': [
    {
      ...BP,
      points: [
        { at: d(3, 10, 10, 0), value: 118 },
        { at: d(9, 9, 10, 5), value: 116 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: d(3, 10, 10, 0), value: 74 },
        { at: d(9, 9, 10, 5), value: 70 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: d(3, 10, 10, 0), value: 61 },
        { at: d(9, 9, 10, 5), value: 60 },
      ],
    },
  ],
  // Rahul — the head-injury observations in Emergency, then today's follow-up
  'SD-P-16': [
    {
      ...BP,
      points: [
        { at: d(9, 14, 23, 40), value: 134 },
        { at: d(9, 15, 1, 40), value: 128 },
        { at: d(9, 15, 3, 40), value: 126 },
        { at: minutesAgo(72), value: 124 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: d(9, 14, 23, 40), value: 92 },
        { at: d(9, 15, 1, 40), value: 84 },
        { at: d(9, 15, 3, 40), value: 78 },
        { at: minutesAgo(72), value: 68 },
      ],
    },
    {
      ...GCS,
      points: [
        { at: d(9, 14, 23, 40), value: 15 },
        { at: d(9, 15, 1, 40), value: 15 },
        { at: d(9, 15, 3, 40), value: 15 },
        { at: minutesAgo(72), value: 15 },
      ],
    },
  ],
}

export function vitalsHistoryFor(patientId: string): VitalSeries[] {
  return VITALS_HISTORY[patientId] ?? []
}
