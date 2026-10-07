// ported from src/components/recordlinks.tsx:32-48 (`recordLinksFor`), the list only:
// every door a patient's record has, in the one fixed order, and a door only where
// there is something behind it — an Imaging button that opens "no study" is worse
// than no button. Addresses go through `canonical`, so the record is `/patient/:id`.

import { resultsFor } from '@/data/clinical'
import { viewableStudyFor } from '@/data/imaging'
import type { Patient } from '@/data/kit'
import { NCCT_STUDIES } from '@/data/ncct.generated'
import { reportsFor } from '@/data/record'
import { strokeCaseForPatient } from '@/data/stroke'

export type RecordLinkKey = 'record' | 'results' | 'reports' | 'imaging' | 'stroke'

export interface RecordLink {
  key: RecordLinkKey
  label: string
  to: string
}

export function recordLinksFor(p: Patient): RecordLink[] {
  const base = `/patient/${p.uhid}`
  const links: RecordLink[] = [{ key: 'record', label: 'Patient record', to: base }]
  if (resultsFor(p.id).length > 0) links.push({ key: 'results', label: 'Test results', to: `${base}/results` })
  if (reportsFor(p.id).length > 0) links.push({ key: 'reports', label: 'Imaging reports', to: `${base}/reports` })
  const study = viewableStudyFor(p.id)
  if (study) links.push({ key: 'imaging', label: 'Latest scan', to: `/radiology/study/${study.id}/view` })
  const sc = strokeCaseForPatient(p.id)
  if (sc && NCCT_STUDIES[sc.id]) links.push({ key: 'stroke', label: 'Stroke-AI console', to: `/stroke/ai-console?case=${sc.id}` })
  return links
}
