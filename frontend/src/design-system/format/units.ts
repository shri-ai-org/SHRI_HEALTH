/**
 * Clinical units for U.S. display. The API sends `Quantity` with a UCUM unit (API_STANDARDS §6.4),
 * which may be metric. Screens show U.S. units: weight in lb, length in in, temperature in °F.
 * Conversion is for display only; values are sent back in the unit the contract asks for.
 */

export interface Quantity {
  value: number
  unit: string
}

export interface DisplayQuantity {
  value: number
  unit: string
  text: string
}

const LB_PER_KG = 2.2046226218
const CM_PER_IN = 2.54

/** UCUM codes → the label U.S. clinicians expect. Unknown codes are shown as sent. */
const UNIT_LABELS: Record<string, string> = {
  '[lb_av]': 'lb',
  '[oz_av]': 'oz',
  '[in_i]': 'in',
  '[ft_i]': 'ft',
  '[degF]': '°F',
  'mm[Hg]': 'mmHg',
  '/min': '/min',
  '%': '%',
  'kg/m2': 'kg/m²',
  'mg/dL': 'mg/dL',
}

/** Converts metric weight, length and temperature to U.S. units and labels the unit. */
export function toUsDisplay(q: Quantity): DisplayQuantity {
  switch (q.unit) {
    case 'kg':
      return make(round(q.value * LB_PER_KG, 1), 'lb')
    case 'g':
      return make(round((q.value / 1000) * LB_PER_KG, 1), 'lb')
    case 'cm':
      return make(round(q.value / CM_PER_IN, 1), 'in')
    case 'm':
      return make(round((q.value * 100) / CM_PER_IN, 1), 'in')
    case 'Cel':
      return make(round((q.value * 9) / 5 + 32, 1), '°F')
    default:
      return make(q.value, UNIT_LABELS[q.unit] ?? q.unit)
  }
}

/** `{ value: 70, unit: '[in_i]' }` → `5 ft 10 in`, the way height is usually said aloud. */
export function formatHeightFeetInches(q: Quantity): string {
  const inches = toUsDisplay(q)
  if (inches.unit !== 'in') return inches.text
  const rounded = Math.round(inches.value)
  return `${Math.floor(rounded / 12)} ft ${rounded % 12} in`
}

export function poundsToKilograms(lb: number): number {
  return lb / LB_PER_KG
}

export function inchesToCentimeters(inches: number): number {
  return inches * CM_PER_IN
}

export function fahrenheitToCelsius(f: number): number {
  return ((f - 32) * 5) / 9
}

function make(value: number, unit: string): DisplayQuantity {
  const spaced = unit === '°F' || unit === '%' ? '' : ' '
  return { value, unit, text: `${value.toLocaleString('en-US')}${spaced}${unit}` }
}

function round(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}
