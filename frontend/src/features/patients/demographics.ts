import type { BirthSex, CodedValue } from '../../api/generated/model'

const SNOMED = 'http://snomed.info/sct'
const DATA_ABSENT = 'http://terminology.hl7.org/CodeSystem/data-absent-reason'

/** Sex assigned at birth (D39), US Core `birthsex`. The contract has no separate "declined", so UNK covers it. */
export const BIRTH_SEX_OPTIONS: Array<{ value: BirthSex; label: string }> = [
  { value: 'F', label: 'Female' },
  { value: 'M', label: 'Male' },
  { value: 'UNK', label: 'Unknown or prefer not to say' },
]

/**
 * Gender identity (D39), from the US Core gender-identity value set (SNOMED CT, plus data-absent-reason
 * for "prefer not to say"). The contract names the value set but not its codes, so this list is
 * waiting on Vimal's confirmation against the US Core version chosen for Q6.
 */
export const GENDER_IDENTITY_OPTIONS: Array<{ key: string; label: string; value: CodedValue }> = [
  { key: 'female', label: 'Female', value: { system: SNOMED, code: '446141000124107', display: 'Identifies as female gender' } },
  { key: 'male', label: 'Male', value: { system: SNOMED, code: '446151000124109', display: 'Identifies as male gender' } },
  { key: 'nonbinary', label: 'Nonbinary', value: { system: SNOMED, code: '33791000087105', display: 'Identifies as nonbinary gender' } },
  { key: 'declined', label: 'Prefer not to say', value: { system: DATA_ABSENT, code: 'asked-declined', display: 'Asked but declined' } },
]

/** Screen label for a stored gender identity: our option label, else the stored display or text. */
export function genderIdentityLabel(value: CodedValue | undefined): string | undefined {
  if (!value) return undefined
  const known = GENDER_IDENTITY_OPTIONS.find((o) => o.value.system === value.system && o.value.code === value.code)
  return known?.label ?? value.display ?? value.text
}

export function birthSexLabel(value: BirthSex | undefined): string | undefined {
  return BIRTH_SEX_OPTIONS.find((o) => o.value === value)?.label
}
