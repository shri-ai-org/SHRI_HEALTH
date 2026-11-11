// SHRI_HEALTH data layer: the prescription screen's formulary search (src/data/clinical.ts
// `FORMULARY`) over GET /codes (searchCodes, RxNorm). Each match keeps the formulary entry's shape;
// RxNorm has no Indian list or price, so `nlem` is false and `ceilingPrice` is unknown (NaN).
import { useEffect, useState } from 'react'

import type { FORMULARY } from '@/data/clinical'
import { useUI } from '@/store/ui'

import { ApiError } from '../../src/api/client'
import { searchCodes } from '../../src/api/generated/endpoints/encounters/encounters'
import type { CodeMatch, CodeMatchList } from '../../src/api/generated/model'
import { problemCopy } from '../../src/design-system/problem/problem'

type FormularyEntry = (typeof FORMULARY)[number]

const LIMIT = 8

/** The RxNorm product behind each drug name the search has shown, for creating its prescription. */
const products = new Map<string, CodeMatch>()

export function rxNormProduct(drug: string): CodeMatch | undefined {
  return products.get(drug)
}

/**
 * RxNorm products matching the search. TODO(gap): an empty search shows nothing, where the
 * mock formulary showed its first six drugs; RxNorm has no shortlist.
 */
export function useFormulary(search: string): FormularyEntry[] {
  const [found, setFound] = useState<FormularyEntry[]>([])
  const q = search.trim()
  useEffect(() => {
    if (q.length < 2) {
      setFound([])
      return
    }
    let current = true
    const t = window.setTimeout(() => {
      searchCodes({ system: 'rxnorm', q, limit: LIMIT })
        .then((res) => {
          if (!current) return
          const items = (res.data as CodeMatchList).items
          for (const c of items) products.set(c.display, c)
          setFound(items.map((c) => ({ drug: c.display, nlem: false, ceilingPrice: Number.NaN, betaLactam: false })))
        })
        .catch((error: unknown) => {
          if (!current) return
          setFound([])
          const copy = error instanceof ApiError ? problemCopy(error.problem) : null
          useUI.getState().toast({ tone: 'critical', title: copy?.title ?? 'The drug search failed', detail: copy?.message })
        })
    }, 200)
    return () => {
      current = false
      window.clearTimeout(t)
    }
  }, [q])
  return q.length < 2 ? [] : found
}
