// ported from src/screens/m13/S1306.tsx:44-89 — the four statutory steps,
// their options, and AI-810's one certain check: a Part I chain that repeats
// a line will not code.
//
// Certifying is one act, wherever it is done: `useCertifyDeath` issues the
// MCCD once per patient, closes the admission as a death (the same record a
// discharge writes, so the patient leaves the ward lists and the bed is
// released), tells the front office, and puts it all on the audit trail —
// where the old wizard showed a toast and recorded nothing.

import { NOW, formatDate } from '@/data/format'
import { patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useClinical, type DeathRecord } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useNotifications } from '../state/notifications'

import { summaryKey } from './discharge'
import { encounterLabel, maybeEncounter } from './encounter'

export const DEATH_STEPS = ['Verification', 'Cause of death', 'Medico-legal', 'Handover'] as const

export const FAMILY_INFORMED = ['In person, by the treating team', 'By telephone', 'Family present at the time', 'Unable to contact'] as const

export const IDENTIFICATION = ['Aadhaar', 'Voter ID', 'Driving licence', 'Passport', 'None — witnessed by two staff'] as const

const norm = (s: string) => s.trim().toLowerCase()

/**
 * AI-810's coherence check, surfaced only when it DISAGREES. A chain that
 * repeats a line is the commonest way a certificate fails to code, and it is
 * the one thing the model can say for certain from the text alone.
 */
export function chainRepeats(a: string, b: string, c: string): boolean {
  return Boolean((a && b && norm(a) === norm(b)) || (c && (norm(c) === norm(a) || norm(c) === norm(b))))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The build's own clock as a `datetime-local` value — a death is never recorded after it. */
export const NOW_LOCAL = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}T${pad(NOW.getHours())}:${pad(NOW.getMinutes())}`

/** Part I as it reads on the certificate: (a) due to (b), due to (c) where there is one. */
export const chainText = (c: DeathRecord['causes']) => `(a) ${c.a} due to (b) ${c.b}${c.c.trim() ? `, due to (c) ${c.c}` : ''}`

export function useCertifyDeath() {
  const me = useCurrentStaff()
  const certify = useClinical((s) => s.certifyDeath)
  const dischargePatient = useClinical((s) => s.dischargePatient)
  const audit = useAudit((s) => s.record)
  const send = useNotifications((s) => s.send)
  const toast = useUI((s) => s.toast)

  return (record: Omit<DeathRecord, 'verifiedBy' | 'registrationNo' | 'certifiedAt'>): boolean => {
    const p = patient(record.patientId)
    const enc = maybeEncounter(record.encounterId)
    const at = NOW.toISOString()
    if (!certify({ ...record, verifiedBy: me.name, registrationNo: me.identifier, certifiedAt: at })) {
      toast({ tone: 'info', title: `${p.name}'s death is already certified`, detail: 'One MCCD per death — a correction is a formal amendment, not a second certificate.' })
      return false
    }
    const summarySigned = useClinical.getState().note(summaryKey(record.encounterId)).status === 'signed'
    dischargePatient({ patientId: p.id, encounterId: record.encounterId, at, by: me.name, kind: 'death', bed: p.bed ?? undefined, summarySigned })
    audit({
      event: 'DEATH.CERTIFIED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      detail: [
        `MCCD Form 4${enc ? ` · ${encounterLabel(enc)}` : ''}`,
        chainText(record.causes),
        record.mlc ? `medico-legal, police acknowledgement filed (${record.police?.stationDocket})` : 'not medico-legal',
        `released to ${record.handover.releasedTo}`,
        'registration queued',
      ].join(' · '),
    })
    send({
      severity: 'routine',
      kind: 'discharge',
      title: p.bed ? `Bed ${p.bed} released` : 'Death certified',
      detail: `${p.name} · death certified; body released to ${record.handover.releasedTo}`,
      to: `/encounter/${record.encounterId}/death`,
      recipient: 'front office',
    })
    toast({
      tone: 'success',
      title: 'MCCD issued',
      detail: `Form 4 certified by ${me.name} on ${formatDate(NOW)}. Registration queued; handover recorded.`,
    })
    return true
  }
}
