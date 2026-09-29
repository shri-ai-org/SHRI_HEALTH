/**
 * S-06-03 · Consultation note — `/encounter/:id/note` (`src/screens/m06/
 * S0603.tsx`): the consultation note that is already written by the time the
 * patient leaves. The authoring surface is the shared `NoteAuthoring`; what
 * makes this the outpatient one is the ambient scribe behind "Draft with AI"
 * (S-06-04, whose drafts arrive as ghost text INSIDE the note, not in a side
 * card) and AI-203's differential in the rail — the confident ones on the
 * surface, the low-confidence ones folded, the rationale behind a Why.
 */

import { BedDouble, ClipboardList, Pill as PillIcon, SearchX } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { screen } from '@/atlas/registry'
import { canAdmit } from '@/data/admissions'
import { noteSeedsFor } from '@/data/clinical'
import { NOW, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useAdmissions } from '@/store/admissions'
import { useClinical } from '@/store/clinical'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenHeader } from '../app/ScreenHeader'
import { differentialsFor, type Differential } from '../logic/differentials'
import { maybeEncounter } from '../logic/encounter'
import { RecordDoors } from '../record/RecordDoors'
import { useOpd } from '../state/opd'
import { useShri } from '../state/store'
import { SuggestionCard } from '../ui/ai'
import { Disclosure, Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { Card, Pill } from '../ui/primitives'

import { AmbientScribe } from './AmbientScribe'
import { NoteAuthoring } from './NoteAuthoring'

export function ConsultationPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-06-03" />
  return <Consultation encounterId={enc.id} />
}

/** An encounter id with nothing behind it says so, rather than a blank app (the old build threw). */
export function NoSuchEncounter({ id, screenId }: { id?: string; screenId: string }) {
  const spec = screen(screenId)
  return (
    <div data-screen-id={spec.id} className="flex flex-col gap-[16px] pb-[8px]">
      <ScreenHeader spec={spec} sub="No encounter at this address." />
      <Card className="max-w-[640px]">
        <EmptyState icon={SearchX} why={`There is no encounter with the id “${id ?? ''}” in this sample record. Open the patient's record, or search with /.`} />
      </Card>
    </div>
  )
}

function Consultation({ encounterId }: { encounterId: string }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const toast = useUI((s) => s.toast)
  const applyScribeDraft = useClinical((s) => s.applyScribeDraft)
  const admissions = useAdmissions((s) => s.admissions)
  const openAdmit = useShri((s) => s.openAdmit)
  const [scribeOpen, setScribeOpen] = useState(false)

  const enc = maybeEncounter(encounterId)!
  const p = patient(enc.patientId)
  // Opening an outpatient consultation is starting it: the patient is In room on every OPD card until the note is signed.
  const start = useOpd((s) => s.start)
  useEffect(() => {
    if (enc.type === 'OP' || enc.type === 'TELE') start(enc.patientId)
  }, [enc.type, enc.patientId, start])
  const seeds = noteSeedsFor(p.id)
  const differentials = differentialsFor(p.id)
  const rx = `/encounter/${enc.id}/rx`
  const order = `/encounter/${enc.id}/orders/new`

  return (
    <>
      <NoteAuthoring
        screenId="S-06-03"
        encounter={enc}
        patient={p}
        seeds={seeds}
        scribeModel="scribe v5.1.2"
        onSigned={() => navigate('/')}
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
            {canAdmit(p, admissions) && (
              <Pill variant="card" size="xl" icon={BedDouble} iconSize={17} onClick={() => openAdmit(p.id)}>
                Admit
              </Pill>
            )}
          </>
        }
        // Last time's results, reports and scans sit one tap from the consultation.
        banner={<RecordDoors patient={p} />}
        rail={<DifferentialRail encounterId={enc.id} patientId={p.id} />}
        railTitle="Differential"
        railBadge={differentials.length || undefined}
      />

      {/* S-06-04, as the overlay it is specified to be. */}
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
                : `${drafted.length === 4 ? 'Four' : drafted.length} ${drafted.length === 1 ? 'section' : 'sections'} drafted`,
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

/** Z6 — AI-203's differential, which suggests and never concludes. */
function DifferentialRail({ encounterId, patientId }: { encounterId: string; patientId: string }) {
  const differentials = differentialsFor(patientId)
  const confident = differentials.filter((d) => d.band !== 'LOW')
  const low = differentials.filter((d) => d.band === 'LOW')

  const card = (d: Differential) => {
    const i = differentials.indexOf(d)
    return (
      <SuggestionCard
        key={d.title}
        touchpointId={`${encounterId}:dx-${i}`}
        capabilityId="AI-203"
        title={d.title}
        evidence={d.evidence}
        band={d.band}
        score={d.confidence}
        gate="G1"
        caution="Suggests, never concludes. This is not a diagnosis."
        explain={{
          touchpointId: `${encounterId}:dx-${i}`,
          capabilityId: 'AI-203',
          claim: `${d.title} is consistent with the charted evidence and worth considering. It is a suggestion, not a conclusion.`,
          confidence: d.confidence,
          band: d.band,
          computedAt: formatTime(NOW),
          inputs: [
            { label: 'Problem list', source: `Problems for ${patientId}` },
            { label: 'Recent results', source: 'Results, last 72 hours' },
            { label: 'Charted vitals', source: 'Flowsheet, most recent set' },
          ],
          evidence: [d.evidence],
          model: 'ddx v2.6.1',
          limits: [
            'Ranks possibilities from the structured record. It does not see examination findings you have not charted yet.',
            'Never concludes and never orders. Your own differential is the fallback.',
            'Not validated as a triage tool for undifferentiated presentations.',
          ],
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-[12px]">
      {differentials.length === 0 && <p className="text-[13px] text-sh-text-3">No differential yet — AI-203 needs charted findings for this visit before it suggests anything.</p>}
      {confident.map(card)}
      {low.length > 0 && (
        <Disclosure label="low-confidence" count={low.length}>
          <div className="flex flex-col gap-[12px]">{low.map(card)}</div>
        </Disclosure>
      )}
      <Why label="How this note is checked">
        <p>
          Documentation quality (AI-114): banned abbreviations are checked when you leave a field and rejected rather than warned about. The message names
          what to write instead — CMP-NABH-05, legible and complete orders.
        </p>
      </Why>
    </div>
  )
}
