/** Person names (HumanName in the contract: `{ given[], family, prefix?, suffix? }`). */

export interface HumanName {
  given?: string[]
  family: string
  prefix?: string
  suffix?: string
}

/** `Kuhlman, Ramona J.`: the list form used at the front desk, family name first. */
export function formatNameFamilyFirst(name: HumanName): string {
  const given = (name.given ?? []).join(' ')
  const tail = [given, name.suffix].filter(Boolean).join(' ')
  return tail ? `${name.family}, ${tail}` : name.family
}

/** `Ramona J. Kuhlman Jr.`: the reading form for headings and letters. */
export function formatNameGivenFirst(name: HumanName): string {
  return [name.prefix, ...(name.given ?? []), name.family, name.suffix].filter(Boolean).join(' ')
}
