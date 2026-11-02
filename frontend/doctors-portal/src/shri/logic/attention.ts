// The attention item My Day ranks for one patient right now (`attentionFor` in
// src/data/myday.ts, over the signed-in persona and the live stores) — for the
// entry points that name a patient rather than an item: a DEV `?open=qp:` and
// an assistant citation. The Quick-Panel always opens on a real item, with its
// reason, finding and band; a patient not on the list has none to open.

import { maybePatient } from '@/data/kit'
import { attentionFor, type AttentionItem } from '@/data/myday'
import { useAdmissions } from '@/store/admissions'
import { useClinical } from '@/store/clinical'
import { useSession } from '@/store/session'

export function listedAttentionFor(patientId: string): AttentionItem | undefined {
  if (!maybePatient(patientId)) return undefined
  const { persona } = useSession.getState()
  return attentionFor(persona, useClinical.getState().acknowledgements, useAdmissions.getState().admissions).find((a) => a.patientId === patientId)
}
