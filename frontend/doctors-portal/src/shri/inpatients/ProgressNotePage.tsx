/**
 * S-08-04 · Progress note — `/ip/encounter/:id/note` (`src/screens/m08/
 * S0804.tsx`): "Where the consultant dictates the daily ward-round note; the
 * scribe drafts on request." Deck beat #12: "The ward round writes itself."
 *
 * The authoring surface is S-06-03's, shared (`notes/NoteAuthoring.tsx`): four
 * empty sections, spoken or typed, Sign waiting for every rule. What makes it
 * the inpatient screen is what surrounds it: AI-102 drafts from the ward round
 * rather than a consultation, AI-201's deterioration strip is the reason you
 * are at the bed, and AI-301 offers the orders the plan implies.
 *
 * Where the old screen fell short: an order accepted from the rail was placed
 * under a fixed id ("RO-0") that the next acceptance reused; it is placed under
 * its own, against this encounter, on the audit trail. AI-201's strip goes with
 * the AI, and says it cannot assess rather than falling silent.
 */

import { ArrowDown, ArrowUp, CircleHelp, ClipboardList, Pill as PillIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { RISK_STRIPS, VITALS, noteSeedsFor, type Encounter } from '@/data/clinical'
import { NOW, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { suggestionsFor } from '../logic/orders'
import { AmbientScribe } from '../notes/AmbientScribe'
import { NoSuchEncounter } from '../notes/ConsultationPage'
import { NoteAuthoring } from '../notes/NoteAuthoring'
import { RecordDoors } from '../record/RecordDoors'
import { useAiActive } from '../state/ai'
import { SuggestionCard } from '../ui/ai'
import { Why } from '../ui/Disclosure'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'

export function ProgressNotePage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-08-04" />
  return <ProgressNote key={enc.id} enc={enc} />
}

function ProgressNote({ enc }: { enc: Encounter }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  const applyScribeDraft = useClinical((s) => s.applyScribeDraft)
  const [scribeOpen, setScribeOpen] = useState(false)

  const p = patient(enc.patientId)
  const seeds = noteSeedsFor(p.id)
  const rx = `/encounter/${enc.id}/rx`
  const order = `/encounter/${enc.id}/orders/new`
  const list = '/ip/patients'

  return (
    <>
      <NoteAuthoring
        screenId="S-08-04"
        encounter={enc}
        patient={p}
        seeds={seeds}
        scribeModel="round-scribe v3.7.0"
        onSigned={() => navigate(may(list) ? list : '/')}
        onDraftAll={() => setScribeOpen(true)}
        headerActions={
          <>
            {may(rx) && (
              <Pill variant="card" size="xl" icon={PillIcon} iconSize={17} onClick={() => navigate(rx)}>
                Prescribe
              </Pill>
            )}
            {may(order) && (
              <Pill variant="card" size="xl" icon={ClipboardList} iconSize={17} onClick={() => navigate(order)}>
                Order
              </Pill>
            )}
          </>
        }
        // Results, reports and the scan are one tap from the note — the ward round needs them beside it.
        banner={<RecordDoors patient={p} />}
        rail={<RoundRail enc={enc} />}
        railBadge={(aiActive && suggestionsFor(p.id).slice(0, 3).length) || undefined}
      />

      {/* The round scribe, on request. Same overlay as the consultation; this patient's own lines. */}
      <AmbientScribe
        open={scribeOpen}
        patientId={p.id}
        patientName={p.name}
        sections={seeds}
        onClose={() => setScribeOpen(false)}
        onFinish={(keys, drafts) => {
          setScribeOpen(false)
          const drafted = applyScribeDraft(enc.id, keys, drafts)
          const kept = keys.length - drafted.length
          toast({
            tone: 'info',
            title:
              drafted.length === 0
                ? 'Nothing to draft — every section already has your words'
                : `${drafted.length} ${drafted.length === 1 ? 'section' : 'sections'} drafted from the round`,
            detail:
              drafted.length === 0
                ? 'The scribe never overwrites what you dictated or typed.'
                : `Each one needs Accept, Edit or Reject before Sign will enable.${kept > 0 ? ` ${kept} you had already written ${kept === 1 ? 'was' : 'were'} left as yours.` : ''}`,
          })
        }}
      />
    </>
  )
}

/** Z6 — why you are at this bed, what was charted, and the orders the plan implies. */
function RoundRail({ enc }: { enc: Encounter }) {
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const placed = useClinical((s) => s.placedOrders)
  const placeOrders = useClinical((s) => s.placeOrders)

  const p = patient(enc.patientId)
  const risk = RISK_STRIPS[p.id]
  const vitals = VITALS[p.id] ?? []
  /** AI-301's suggestions are drawn from R. Lakshmanan's plan; nobody else inherits them. */
  const suggestions = suggestionsFor(p.id).slice(0, 3)

  /** Accepting places the order against this encounter — once, under its own id. */
  function placeFromRound(item: string, i: number) {
    const id = `O-${enc.id}-R-${i}`
    if (placed.some((o) => o.id === id)) return
    placeOrders([{ id, item, priority: 'Routine', encounterId: enc.id }], p.id, me.name, NOW.toISOString())
    audit({ event: 'ORDER.PLACED', actor: me.name, actorId: me.id, subject: p.id, model: 'order-sug v3.0.2', gate: 'G2', detail: `${item} · from the round plan · ${encounterLabel(enc)}` })
    toast({ tone: 'success', title: `${item} placed`, detail: 'It appears on the active orders screen and in the performing department queue.' })
  }

  return (
    <div className="flex flex-col gap-[12px]">
      {/* Why you are at this bed — AI-201's, so only while it is live; where it cannot score, it says so. */}
      {aiActive && risk && (
        <Card
          titleSize="sm"
          title={risk.band === 'ABSTAIN' ? 'Deterioration risk' : `Deterioration risk ${risk.band}`}
          className="border-l-[3px] border-sh-warn"
          right={
            risk.band === 'ABSTAIN' && (
              <PillTag tone="warn" size="sm" icon={CircleHelp}>
                Cannot assess
              </PillTag>
            )
          }
        >
          {risk.band === 'ABSTAIN' ? (
            <p className="text-[13px] text-sh-text-2">{risk.abstainReason ?? 'Not enough charted data to score.'}</p>
          ) : (
            <>
              <p className="text-[14px] tabular-nums text-sh-text" title={`${risk.modelVersion} · computed ${formatTime(risk.computedAt)}`}>
                {risk.score} · {risk.trend}
              </p>
              <ul className="mt-[10px] flex flex-col gap-[4px]">
                {risk.drivers.map((d) => (
                  <li key={d.label} className="flex items-center gap-[6px] text-[13px] text-sh-text-2">
                    <Icon icon={d.direction === 'up' ? ArrowUp : ArrowDown} size={12} className={d.direction === 'up' ? 'text-sh-warn-fg' : 'text-sh-pend-fg'} />
                    {d.label}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      <Card titleSize="sm" title="Latest observations">
        {vitals.length === 0 ? (
          <p className="text-[13px] text-sh-text-2">No observations have been charted for this patient in this record.</p>
        ) : (
          <>
            <dl className="flex flex-col">
              {vitals.map((v, i) => (
                <div key={v.label} className={`flex justify-between gap-[8px] py-[8px] ${i > 0 ? 'border-t border-sh-line' : 'pt-0'}`}>
                  <dt className="text-[13px] text-sh-text-2">{v.label}</dt>
                  <dd className="text-[13px] font-medium tabular-nums text-sh-text">{v.value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-[8px] text-[12px] tabular-nums text-sh-text-3">charted {formatTime(vitals[0].at)}</p>
          </>
        )}
      </Card>

      {/* AI-301 — the orders the plan implies, offered rather than placed. */}
      {aiActive && (
        <div className="flex flex-col gap-[10px]">
          <h3 className="text-[13px] font-semibold text-sh-text-2">Orders this plan implies</h3>
          {suggestions.length === 0 && <p className="text-[13px] text-sh-text-3">Nothing to suggest yet — suggestions follow from the plan once it is written.</p>}
          {suggestions.map((s, i) => (
            <SuggestionCard
              key={s.item}
              touchpointId={`${enc.id}:round-order-${i}`}
              capabilityId="AI-301"
              title={s.item}
              evidence={s.evidence}
              band={s.band}
              score={s.confidence}
              gate="G2"
              onAccept={() => placeFromRound(s.item, i)}
              explain={{
                touchpointId: `${enc.id}:round-order-${i}`,
                capabilityId: 'AI-301',
                claim: `${s.item} follows from the plan you have drafted.`,
                confidence: s.confidence,
                band: s.band,
                computedAt: formatTime(NOW),
                inputs: [
                  { label: 'Drafted plan section', source: encounterLabel(enc) },
                  { label: 'Recent results', source: 'Results, last 72 hours' },
                  { label: 'Charted vitals', source: 'Flowsheet, most recent set' },
                ],
                evidence: [s.evidence],
                model: 'order-sug v3.0.2',
                limits: [
                  'Reads the plan text and the structured record; it does not examine the patient.',
                  'Accepting places the order against this encounter — it is not a standing instruction.',
                  'Manual order search is always available.',
                ],
              }}
            />
          ))}
        </div>
      )}

      <Why label="About the round scribe">
        <p>
          The ward-round variant of the scribe. It listens at the bedside rather than in a consulting room, so it expects a shorter, more telegraphic dictation and drafts
          accordingly. Fallback: type manually.
        </p>
      </Why>
    </div>
  )
}
