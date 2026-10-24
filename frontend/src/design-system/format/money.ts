/**
 * Money display (API_STANDARDS §6.3, D40). The API sends `{ value: "125.00", currency: "USD" }` with
 * the amount as a decimal string; it is formatted as text and never turned into a float.
 */

export interface Money {
  value: string
  currency: 'USD'
}

const MONEY_VALUE = /^(-?)(\d{1,9})\.(\d{2})$/

/** `{ value: "1234.50" }` → `$1,234.50`; negative → `-$5.00`. */
export function formatMoney(money: Money): string {
  const m = MONEY_VALUE.exec(money.value)
  if (!m) return money.value
  const [, sign, whole = '', cents = ''] = m
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}$${grouped}.${cents}`
}

/** What a user typed (`$1,234.5`, `25`) → a contract value string (`1234.50`), or `null`. */
export function parseMoneyInput(input: string): string | null {
  const cleaned = input.trim().replace(/[$,\s]/g, '')
  const m = /^(-?)(\d{1,9})(?:\.(\d{0,2}))?$/.exec(cleaned)
  if (!m) return null
  const [, sign, whole = '', cents = ''] = m
  return `${sign}${String(Number(whole))}.${cents.padEnd(2, '0')}`
}
