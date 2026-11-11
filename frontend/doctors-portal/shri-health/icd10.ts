// SHRI_HEALTH data layer: the ICD-10 picker's search (src/data/icd10.ts `searchIcd`) over
// GET /codes (searchCodes, ICD-10-CM). A network search can't be synchronous inside the picker's
// useMemo, so it is a hook: the picker calls it beside the memo (its one data-call change).
import { useEffect, useState } from 'react'

import type { IcdEntry } from '@/data/icd10'
import { useUI } from '@/store/ui'

import { searchCodes } from '../../src/api/generated/endpoints/encounters/encounters'
import type { CodeMatchList } from '../../src/api/generated/model'
import { ApiError } from '../../src/api/client'
import { problemCopy } from '../../src/design-system/problem/problem'

export { icdCategoriesOf, normaliseIcd, type IcdCode, type IcdEntry } from '@/data/icd10'

const LIMIT = 8 // as searchIcd

/**
 * ICD-10-CM codes matching the query: billable codes are leaves; header codes come back as
 * parents, which the picker shows as "parent only". `extra` (the screen's mock diagnoses) is not
 * searched: every code comes from the practice's ICD-10-CM release (TODO: drop it from the screen).
 */
export function useSearchIcd(query: string, _options: { extra?: IcdEntry[] } = {}): IcdEntry[] {
  const [found, setFound] = useState<IcdEntry[]>([])
  const q = query.trim()
  useEffect(() => {
    if (q.length < 2) {
      setFound([])
      return
    }
    let current = true
    const t = window.setTimeout(() => {
      searchCodes({ system: 'icd-10-cm', q, limit: LIMIT })
        .then((res) => {
          if (current) setFound((res.data as CodeMatchList).items.map((c) => ({ code: c.code, label: c.display, leaf: c.billable === true })))
        })
        .catch((error: unknown) => {
          if (!current) return
          setFound([])
          const copy = error instanceof ApiError ? problemCopy(error.problem) : null
          useUI.getState().toast({ tone: 'critical', title: copy?.title ?? 'The ICD-10 search failed', detail: copy?.message })
        })
    }, 200)
    return () => {
      current = false
      window.clearTimeout(t)
    }
  }, [q])
  return q.length < 2 ? [] : found
}
