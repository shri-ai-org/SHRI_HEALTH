/**
 * S-05-06 · Referrals — `/referrals` (`src/screens/m05/S0506.tsx`): "Referrals
 * in, triaged rather than queued."
 *
 * AI-609 proposes each referral's urgency at G2 — accept, edit or reject, and
 * a rejection needs a reason. The cards ARE the list: one per referral, with
 * the referrer's reason verbatim, the disposition bar and the booking on it,
 * opening on the ones still to triage. With the AI off the order is date
 * received. Referring doctors have no login: a referral is inbound data, so
 * the reply goes back out as a letter naming the slot.
 */

import { CalendarCheck, Check, ChevronDown, ChevronRight, Clock, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { REFERRALS, type ReferralRow } from '@/data/clinical'
import { NOW, formatDateTime, formatElapsed, formatTime } from '@/data/format'
import { useAI } from '@/store/ai'
import { useClinical } from '@/store/clinical'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import type { Tone } from '../mocks/types'
import { useScope } from '../logic/scope'
import { useAiActive } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { Why } from '../ui/Disclosure'
import { Select } from '../ui/forms'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { RankedSort } from '../ui/RankedSort'
import { Segmented } from '../ui/Segmented'

const TARGETS: Record<ReferralRow['triage'], string> = { Urgent: '48 hours', Soon: '2 weeks', Routine: '6 weeks' }
const TRIAGE_TONE: Record<ReferralRow['triage'], Tone> = { Urgent: 'crit', Soon: 'warn', Routine: 'neu' }
const ORDER: Record<ReferralRow['triage'], number> = { Urgent: 0, Soon: 1, Routine: 2 }
const SCOPES = ['triage', 'done'] as const
const SLOTS = ['Tue 22-Sep 09:20 · rapid access', 'Thu 24-Sep 11:00 · general clinic', 'Mon 05-Oct 10:40 · general clinic']

export function ReferralsPage() {
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  const dispositions = useAI((s) => s.dispositions)
  const triagedReferrals = useClinical((s) => s.triagedReferrals)
  const triageReferral = useClinical((s) => s.triageReferral)
  const [aiSort, setAiSort] = useState(true)
  const [slots, setSlots] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [scope, setScope] = useScope(SCOPES, 'triage')

  const byDate = [...REFERRALS].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
  const sorted = aiActive && aiSort ? [...byDate].sort((a, b) => ORDER[a.triage] - ORDER[b.triage]) : byDate

  const done = (r: ReferralRow) => dispositions[`referral:${r.id}`] !== undefined || triagedReferrals[r.id] !== undefined
  const toTriage = sorted.filter((r) => !done(r))
  const triaged = sorted.filter(done)
  const rows = scope === 'triage' ? toTriage : triaged
  const urgent = toTriage.filter((r) => r.triage === 'Urgent').length

  return (
    <ScreenFrame
      screenId="S-05-06"
      heading="Referrals"
      sub={`${toTriage.length} to triage${urgent > 0 ? ` · ${urgent} urgent` : ''}${triaged.length > 0 ? ` · ${triaged.length} triaged` : ''}`}
      empty={
        <Card className="items-center p-[40px] text-center">
          <p className="text-[18px] font-medium">No referrals waiting.</p>
          <p className="mx-auto mt-[8px] max-w-[448px] text-sh-text-3">
            A referral from a GP, another facility in the group or an external clinic would arrive here. Referring doctors send in; they do not have a login.
          </p>
        </Card>
      }
    >
      <div className="flex max-w-[896px] flex-col gap-[16px]">
        <div className="flex flex-wrap items-center justify-between gap-[12px]">
          <Segmented
            label="Which referrals"
            value={scope}
            onChange={setScope}
            options={[
              { key: 'triage', label: 'To triage', count: toTriage.length },
              { key: 'done', label: 'Triaged / booked', count: triaged.length },
            ]}
          />
          <RankedSort aiSort={aiSort} onChange={setAiSort} aiLabel="Clinical urgency" deterministicLabel="Date received" capabilityId="AI-609" label="Sort the referrals" />
        </div>

        {rows.length === 0 ? (
          <Card className="p-[32px] text-center text-sh-text-2">
            {scope === 'triage' ? 'Every referral has a triage decision. The booked ones are one tap away.' : 'Nothing has been triaged yet.'}
          </Card>
        ) : (
          <ul aria-label="Inbound referrals" className="flex flex-col gap-[16px]">
            {rows.map((r) => {
              const booked = triagedReferrals[r.id]
              const open = expanded[r.id] ?? false
              return (
                <li key={r.id}>
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-[8px]">
                      <div className="min-w-0">
                        <h3 className="font-semibold">
                          {r.patientName} · {r.speciality}
                        </h3>
                        <p className="text-[13px] text-sh-text-3">
                          {r.fromDoctor} · {r.fromFacility} · <span className="tabular-nums">{formatElapsed((NOW.getTime() - r.receivedAt.getTime()) / 60000)} ago</span>
                        </p>
                      </div>
                      {/* The urgency is the AI's proposal, so it goes with the AI; the target it implies stays on the bar's explanation. */}
                      {aiActive && (
                        <PillTag tone={TRIAGE_TONE[r.triage]} size="sm" icon={r.triage === 'Urgent' ? TriangleAlert : Clock}>
                          {r.triage} · {TARGETS[r.triage]}
                        </PillTag>
                      )}
                    </div>

                    {/* The referrer's reason, verbatim — one line until asked. */}
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpanded((e) => ({ ...e, [r.id]: !open }))}
                      className="mt-[12px] flex min-h-[44px] w-full items-start gap-[8px] rounded-[14px] bg-sh-inner px-[16px] py-[10px] text-left text-sh-text-2 transition-colors duration-150 hover:bg-sh-hover-strong"
                    >
                      <span className={cn('min-w-0 flex-1', !open && 'truncate')}>&ldquo;{r.reason}&rdquo;</span>
                      <Icon icon={open ? ChevronDown : ChevronRight} size={14} className="mt-[4px] text-sh-text-3" />
                    </button>

                    <AIActionBar
                      className="mt-[12px]"
                      touchpointId={`referral:${r.id}`}
                      capabilityId="AI-609"
                      gate="G2"
                      band={r.band}
                      score={r.confidence}
                      explain={{
                        touchpointId: `referral:${r.id}`,
                        capabilityId: 'AI-609',
                        claim: `This referral is proposed as ${r.triage.toLowerCase()}, with a ${TARGETS[r.triage]} target.`,
                        confidence: r.confidence,
                        band: r.band,
                        computedAt: formatTime(NOW),
                        inputs: [
                          { label: 'Referral reason as written', source: `Referral ${r.id}` },
                          { label: 'Speciality triage criteria', source: 'Departmental triage policy' },
                          { label: 'Referrer and facility', source: r.fromFacility },
                        ],
                        evidence: [r.reason609],
                        model: 'referral-triage v1.9.0',
                        limits: [
                          'Reads the referral text. It does not have the patient’s record at the referring practice.',
                          'A referral written vaguely triages low, which is a property of the letter rather than the patient.',
                          'Manual triage is the fallback and remains available on every row.',
                        ],
                      }}
                    />

                    {booked ? (
                      <p className="mt-[12px] flex flex-wrap items-center gap-[8px] text-[13px]">
                        <PillTag tone="norm" size="sm" icon={Check}>
                          Booked
                        </PillTag>
                        <span className="text-sh-text-2">{booked.outcome}</span>
                        <span className="tabular-nums text-sh-text-3">· received {formatDateTime(r.receivedAt)}</span>
                      </p>
                    ) : (
                      <div className="mt-[12px] flex flex-wrap items-end gap-[12px]">
                        <label className="min-w-[192px] flex-1">
                          <span className="mb-[6px] block text-[13px] font-medium text-sh-text-2">Book into</span>
                          <Select value={slots[r.id] ?? ''} onChange={(e) => setSlots((s) => ({ ...s, [r.id]: e.target.value }))} aria-label={`Slot for ${r.patientName}`}>
                            <option value="">Choose a slot…</option>
                            {SLOTS.map((s) => (
                              <option key={s}>{s}</option>
                            ))}
                          </Select>
                        </label>
                        <Pill
                          variant="primary"
                          size="xl"
                          icon={CalendarCheck}
                          disabled={!slots[r.id]}
                          onClick={() => {
                            triageReferral(r.id, slots[r.id])
                            toast({ tone: 'success', title: `${r.patientName} booked`, detail: `${slots[r.id]}. A confirmation goes back to ${r.fromDoctor}.` })
                          }}
                        >
                          Book and reply to the referrer
                        </Pill>
                      </div>
                    )}
                  </Card>
                </li>
              )
            })}
          </ul>
        )}

        <Why label="Why referrals are triaged, not queued">
          <p>
            A date-ordered inbox puts a chest pain with ischaemic changes behind a stable psoriasis that arrived yesterday. Triage is the whole difference, and it is proposed at G2
            so a wrong call is visibly yours to overturn. Fallback: manual triage.
          </p>
          <dl className="grid max-w-[320px] grid-cols-[auto_1fr] gap-x-[16px] gap-y-[4px] tabular-nums">
            {(['Urgent', 'Soon', 'Routine'] as const).map((t) => (
              <div key={t} className="contents">
                <dt className="text-sh-text-3">{t}</dt>
                <dd>seen within {TARGETS[t]}</dd>
              </div>
            ))}
          </dl>
          <p>
            The referring doctor has no login. A referral is inbound data, not a portal session, so everything the referrer needs to know goes back out as a letter and a status
            update — which is why the reason they wrote is shown verbatim rather than summarised, and why the reply names the slot, not the reason for the visit.
          </p>
        </Why>
      </div>
    </ScreenFrame>
  )
}
