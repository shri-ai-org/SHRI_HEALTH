import { formatAddressLines, isValidState, isValidZip, normalizeZip } from './address'
import {
  ageInYears,
  formatDate,
  formatDateTime,
  formatPartialDate,
  formatTime,
  isValidTimeZone,
  parsePartialDate,
  parseUsDate,
  todayIn,
} from './datetime'
import { formatMoney, parseMoneyInput } from './money'
import { formatNameFamilyFirst, formatNameGivenFirst } from './names'
import { formatPhone, parseUsPhone } from './phone'
import { formatHeightFeetInches, toUsDisplay } from './units'

describe('dates', () => {
  it('shows calendar dates as MM/DD/YYYY without a time zone shift', () => {
    expect(formatDate('1984-07-19')).toBe('07/19/1984')
    expect(formatDate('2011-05')).toBe('2011-05')
  })

  it('parses typed U.S. dates and rejects impossible ones', () => {
    expect(parseUsDate('7/19/1984')).toBe('1984-07-19')
    expect(parseUsDate('02/29/2024')).toBe('2024-02-29')
    expect(parseUsDate('02/29/2026')).toBeNull()
    expect(parseUsDate('19/07/1984')).toBeNull()
    expect(parseUsDate('1984-07-19')).toBeNull()
  })

  it('shows a partial date with only what is known', () => {
    expect(formatPartialDate('2011')).toBe('2011')
    expect(formatPartialDate('2011-05')).toBe('05/2011')
    expect(formatPartialDate('2011-05-14')).toBe('05/14/2011')
  })

  it('parses a typed partial date and rejects impossible ones', () => {
    expect(parsePartialDate(' 2011 ')).toBe('2011')
    expect(parsePartialDate('5/2011')).toBe('2011-05')
    expect(parsePartialDate('05/14/2011')).toBe('2011-05-14')
    expect(parsePartialDate('13/2011')).toBeNull()
    expect(parsePartialDate('02/30/2011')).toBeNull()
    expect(parsePartialDate('1850')).toBeNull()
    expect(parsePartialDate('2011-05')).toBeNull()
    expect(parsePartialDate('')).toBeNull()
  })

  it('derives age from the birth date', () => {
    expect(ageInYears('1984-07-19', '2026-07-18')).toBe(41)
    expect(ageInYears('1984-07-19', '2026-07-19')).toBe(42)
  })

  it('shows instants in the facility time zone on a 12-hour clock', () => {
    expect(formatTime('2026-11-03T14:30:00Z', 'America/Chicago')).toBe('8:30 AM CST')
    expect(formatTime('2026-07-03T21:05:00Z', 'America/New_York')).toBe('5:05 PM EDT')
    expect(formatTime('2026-07-03T21:05:00Z', 'America/New_York', { withZone: false })).toBe('5:05 PM')
    expect(formatDateTime('2026-11-03T14:30:00Z', 'America/Los_Angeles')).toBe('11/03/2026, 6:30 AM PST')
  })

  it("gives today's date in the facility, not the browser", () => {
    expect(todayIn('America/Los_Angeles', new Date('2026-11-04T05:00:00Z'))).toBe('2026-11-03')
    expect(todayIn('America/New_York', new Date('2026-11-04T05:00:00Z'))).toBe('2026-11-04')
    expect(todayIn(null, new Date('2026-11-04T05:00:00Z'))).toBe('2026-11-04')
  })

  it('shows UTC with a visible marker when the facility time zone is missing or invalid', () => {
    const at = '2026-11-03T14:30:00Z'
    expect(formatTime(at, null)).toBe('2:30 PM UTC · time zone missing')
    expect(formatTime(at, '')).toBe('2:30 PM UTC · time zone missing')
    expect(formatTime(at, undefined as unknown as string)).toBe('2:30 PM UTC · time zone missing')
    expect(formatTime(at, 'Mars/Olympus_Mons')).toBe('2:30 PM UTC · time zone missing')
    // The marker stays even where the zone name is normally hidden.
    expect(formatTime(at, null, { withZone: false })).toBe('2:30 PM UTC · time zone missing')
    expect(formatDateTime(at, 'not-a-zone')).toBe('11/03/2026, 2:30 PM UTC · time zone missing')
    expect(isValidTimeZone('America/Phoenix')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
  })

  it('handles daylight saving changes and zones without them', () => {
    // Chicago: DST ends 1 Nov 2026 at 2:00 AM.
    expect(formatTime('2026-11-01T06:30:00Z', 'America/Chicago')).toBe('1:30 AM CDT')
    expect(formatTime('2026-11-01T07:30:00Z', 'America/Chicago')).toBe('1:30 AM CST')
    expect(formatTime('2026-07-03T21:05:00Z', 'America/Phoenix')).toBe('2:05 PM MST')
    expect(formatTime('2026-07-03T21:05:00Z', 'Pacific/Honolulu')).toBe('11:05 AM HST')
  })
})

describe('money', () => {
  it('formats USD from the decimal string without floats', () => {
    expect(formatMoney({ value: '25.00', currency: 'USD' })).toBe('$25.00')
    expect(formatMoney({ value: '1234567.50', currency: 'USD' })).toBe('$1,234,567.50')
    expect(formatMoney({ value: '-5.00', currency: 'USD' })).toBe('-$5.00')
  })

  it('parses typed amounts into the contract format', () => {
    expect(parseMoneyInput('$1,234.5')).toBe('1234.50')
    expect(parseMoneyInput('25')).toBe('25.00')
    expect(parseMoneyInput('0.1')).toBe('0.10')
    expect(parseMoneyInput('12.345')).toBeNull()
    expect(parseMoneyInput('abc')).toBeNull()
  })

  it('refuses negatives unless allowed, and commas that are not thousands', () => {
    expect(parseMoneyInput('-5')).toBeNull()
    expect(parseMoneyInput('-5', { allowNegative: true })).toBe('-5.00')
    expect(parseMoneyInput('1,2,3')).toBeNull()
    expect(parseMoneyInput('12,34')).toBeNull()
    expect(parseMoneyInput('1,234,567.8')).toBe('1234567.80')
    expect(parseMoneyInput('1234567890')).toBeNull()
  })
})

describe('phone', () => {
  it('shows E.164 U.S. numbers in the familiar format', () => {
    expect(formatPhone('+16175550123')).toBe('(617) 555-0123')
    expect(formatPhone('+442071234567')).toBe('+442071234567')
  })

  it('parses typed U.S. numbers to E.164', () => {
    expect(parseUsPhone('617-555-0123')).toBe('+16175550123')
    expect(parseUsPhone('1 (617) 555 0123')).toBe('+16175550123')
    expect(parseUsPhone('117-555-0123')).toBeNull()
    expect(parseUsPhone('+91 98765 43210')).toBeNull()
    expect(parseUsPhone('555-0123')).toBeNull()
  })
})

describe('address', () => {
  it('validates ZIP, ZIP+4 and USPS states', () => {
    expect(isValidZip('62701')).toBe(true)
    expect(isValidZip('62701-1234')).toBe(true)
    expect(isValidZip('560001')).toBe(false)
    expect(normalizeZip('627011234')).toBe('62701-1234')
    expect(isValidState('IL')).toBe(true)
    expect(isValidState('KA')).toBe(false)
  })

  it('builds mailing lines', () => {
    expect(
      formatAddressLines({ lines: ['100 Main St', 'Apt 2'], city: 'Springfield', state: 'IL', postalCode: '62701' }),
    ).toEqual(['100 Main St', 'Apt 2', 'Springfield, IL 62701'])
  })
})

describe('units', () => {
  it('shows metric vitals in U.S. units', () => {
    expect(toUsDisplay({ value: 70, unit: 'kg' }).text).toBe('154.3 lb')
    expect(toUsDisplay({ value: 177.8, unit: 'cm' }).text).toBe('70 in')
    expect(toUsDisplay({ value: 37, unit: 'Cel' }).text).toBe('98.6°F')
    expect(toUsDisplay({ value: 98.6, unit: '[degF]' }).text).toBe('98.6°F')
    expect(toUsDisplay({ value: 120, unit: 'mm[Hg]' }).text).toBe('120 mmHg')
    expect(toUsDisplay({ value: 5, unit: 'mmol/L' }).text).toBe('5 mmol/L')
  })

  it('shows height in feet and inches', () => {
    expect(formatHeightFeetInches({ value: 70, unit: '[in_i]' })).toBe('5 ft 10 in')
    expect(formatHeightFeetInches({ value: 165, unit: 'cm' })).toBe('5 ft 5 in')
  })
})

describe('names', () => {
  it('formats HumanName both ways', () => {
    const name = { given: ['Ramona', 'J.'], family: 'Kuhlman', suffix: 'Jr.' }
    expect(formatNameFamilyFirst(name)).toBe('Kuhlman, Ramona J. Jr.')
    expect(formatNameGivenFirst(name)).toBe('Ramona J. Kuhlman Jr.')
  })
})
