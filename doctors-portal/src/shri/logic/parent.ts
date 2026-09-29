// ported from src/shell/Screen.tsx:94-111 (`parentOf`), with the two addresses
// that moved (My Day at `/`, the record at `/patient/:id`) and one fix: the
// label names the persona's real landing ("Imaging worklist" for a radiologist)
// where the old build always said "My Day".

import { screenForPath } from '@/atlas/registry'

export interface Parent {
  to: string
  label: string
}

/**
 * Where Back goes when there is no earlier screen in this tab — the screen a
 * route naturally sits under. `null` means this IS the top (the landing).
 */
export function parentOf(pathname: string, landing: string): Parent | null {
  const home: Parent = { to: landing, label: landing === '/' ? 'My Day' : (screenForPath(landing)?.name ?? 'My Day') }
  const patient = /^\/patient\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
  if (patient) return patient[2] === undefined ? home : { to: `/patient/${patient[1]}`, label: 'Patient record' }
  if (pathname.startsWith('/radiology/study/')) return { to: '/radiology/worklist', label: 'Imaging worklist' }
  if (/^\/results\/(?!inbox)/.test(pathname)) return { to: '/results/inbox', label: 'Results' }
  if (pathname.startsWith('/ip/encounter/')) return { to: '/ip/patients', label: 'Inpatients' }
  if (pathname.startsWith('/encounter/')) return { to: '/op-queue', label: 'OPD' }
  if (pathname.startsWith('/stroke/case/')) return { to: '/stroke/ai-console', label: 'Stroke-AI Console' }
  const rx = /^\/tele\/session\/([^/]+)\/rx$/.exec(pathname)
  if (rx) return { to: `/tele/session/${rx[1]}`, label: 'Teleconsult' }
  if (pathname.startsWith('/tele/session/')) return { to: '/tele/queue', label: 'Telehealth' }
  if (pathname === landing) return null
  return home
}
