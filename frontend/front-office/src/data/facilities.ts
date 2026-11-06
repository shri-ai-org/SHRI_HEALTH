// TEMPORARY MOCK DATA — no facility/tenant list is confirmed to exist yet
// (plan §18). Replace with a real facility service when one is confirmed.

export interface Facility {
  id: string
  name: string
  code: string
}

export const facilities: Facility[] = [
  { id: 'shri-main', name: 'SHRI Medical Center', code: 'SHRI' },
  { id: 'shri-north', name: 'SHRI North Campus', code: 'SHRN' },
  { id: 'shri-women', name: "SHRI Women & Children's Hospital", code: 'SHRW' },
  { id: 'shri-heart', name: 'SHRI Heart & Vascular Institute', code: 'SHRV' },
]

export function getFacilityById(id: string): Facility {
  return facilities.find((facility) => facility.id === id) ?? facilities[0]
}
