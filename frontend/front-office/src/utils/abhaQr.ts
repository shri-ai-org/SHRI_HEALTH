// Reading an ABHA card's QR code. The card's QR holds a small JSON object —
// field names differ between card versions (hidn / abhaNumber, hid /
// abhaAddress / phr, name / fullName, dob / yob …), so every known spelling is
// tried. A QR or barcode holding only the ABHA number or address is read too.
import { normalizeAbha } from './validation'
import { nationalMobile } from './phone'
import type { Sex } from '../types/patient'

export interface AbhaScan {
  /** "xx-xxxx-xxxx-xxxx" */
  abhaNumber?: string
  /** "name@abdm" */
  abhaAddress?: string
  name?: string
  sex?: Sex
  /** Whole years, from the date or year of birth. */
  age?: number
  /** 10-digit national mobile. */
  mobile?: string
  address?: string
}

const KEYS = {
  number: ['hidn', 'abhanumber', 'healthidnumber', 'abha_number', 'abhano'],
  address: ['hid', 'abhaaddress', 'phr', 'healthid', 'phraddress', 'abha_address'],
  name: ['name', 'fullname', 'full_name'],
  gender: ['gender', 'sex'],
  dob: ['dob', 'dateofbirth', 'date_of_birth', 'birthdate'],
  yob: ['yob', 'yearofbirth', 'year_of_birth'],
  mobile: ['mobile', 'phone', 'mobileno', 'mobile_number'],
  address2: ['address', 'addr'],
}

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const [key, value] of Object.entries(obj)) {
    if (keys.includes(key.toLowerCase()) && value != null && String(value).trim()) return String(value).trim()
  }
  return undefined
}

function sexOf(value: string | undefined): Sex | undefined {
  const v = (value ?? '').trim().toLowerCase()
  if (v === 'm' || v === 'male') return 'Male'
  if (v === 'f' || v === 'female') return 'Female'
  if (v === 'o' || v === 'other' || v === 't' || v === 'transgender') return 'Other'
  return undefined
}

/** Years since a date of birth (dd-mm-yyyy, dd/mm/yyyy, yyyy-mm-dd) or a year of birth. */
function ageOf(dob: string | undefined, yob: string | undefined, today: Date): number | undefined {
  let y: number | undefined
  let m = 1
  let d = 1
  const text = (dob ?? '').trim()
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text)
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text)
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])]
  else if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])]
  else if (/^\d{4}$/.test(text)) y = Number(text)
  else if (yob && /^\d{4}$/.test(yob.trim())) y = Number(yob.trim())
  if (!y) return undefined
  let age = today.getFullYear() - y
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1
  return age >= 0 && age <= 130 ? age : undefined
}

function abhaNumberOf(value: string | undefined): string | undefined {
  const digits = (value ?? '').replace(/\D/g, '')
  return digits.length === 14 ? normalizeAbha(digits) : undefined
}

function abhaAddressOf(value: string | undefined): string | undefined {
  const text = (value ?? '').trim().toLowerCase()
  if (!text) return undefined
  // Older cards carry "@ndhm"; the same address is "@abdm" today. A bare handle gets "@abdm".
  if (text.endsWith('@ndhm')) return text.replace(/@ndhm$/, '@abdm')
  return text.includes('@') ? text : `${text}@abdm`
}

/** What a scanned code says about an ABHA holder — null when it is not an ABHA code. */
export function parseAbhaScan(raw: string, today: Date = new Date()): AbhaScan | null {
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(text) as Record<string, unknown>
    } catch {
      return null
    }
    const scan: AbhaScan = {
      abhaNumber: abhaNumberOf(pick(obj, KEYS.number)),
      abhaAddress: abhaAddressOf(pick(obj, KEYS.address)),
      name: pick(obj, KEYS.name),
      sex: sexOf(pick(obj, KEYS.gender)),
      age: ageOf(pick(obj, KEYS.dob), pick(obj, KEYS.yob), today),
      mobile: (() => {
        const digits = nationalMobile(pick(obj, KEYS.mobile) ?? '')
        return digits.length === 10 ? digits : undefined
      })(),
      address: pick(obj, KEYS.address2),
    }
    return scan.abhaNumber || scan.abhaAddress ? scan : null
  }
  // A plain ABHA number or address.
  const number = abhaNumberOf(text)
  if (number && /^[\d\s-]+$/.test(text)) return { abhaNumber: number }
  if (/^[a-z0-9._]+@(abdm|ndhm|sbx)$/i.test(text)) return { abhaAddress: abhaAddressOf(text) }
  return null
}

/** Sent to the open page when a code is scanned on Register Patient. */
export const ABHA_SCAN_EVENT = 'care-entry:abha-scan'

/** Sent to Register Patient when a scanned card has just registered its holder there. */
export const ABHA_REGISTERED_EVENT = 'care-entry:abha-registered'
