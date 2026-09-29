/**
 * S-18-18 · EVT selection — `/stroke/case/:id/evt` (`src/screens/m18/
 * S1818.tsx`): "Selecting for thrombectomy, and recording the disagreement."
 *
 * The second half of that title is the reason the screen exists: where the
 * neurologist and the interventionist disagree, the disagreement is recorded
 * rather than resolved silently, and it travels with the decision into the
 * registry. It never blocks the decision, and cost never blocks either.
 *
 * Removed, as a forecast (decision 8): AI-221's predicted-outcome card — the
 * mRS 0–2 at 90 days with and without thrombectomy — and the rationale for it.
 * Fixed: the disagreement dialog's "Record it" silently did nothing under ten
 * characters; it now waits for them. Another case than the one this checklist
 * was drawn for sees its own rule-based thrombectomy criteria (`NotLvo`).
 */

import { Activity, Check, MessageSquareWarning, Route } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatRupees, formatTime } from '@/data/format'
import { STAFF, patient, tariff } from '@/data/kit'
import { EVT_CRITERIA, type StrokeCase } from '@/data/stroke'
import { useCurrentStaff } from '@/store/session'
import { useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { useCaseClock } from '../logic/caseClock'
import { isIndexCase, useStrokeCaseParam } from '../logic/strokeCase'
import { isBlocking } from '../logic/thrombolysis'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { Select, TextArea } from '../ui/forms'
import { KeyValue } from '../ui/KeyValue'
import { Card, Pill, PillTag } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { Checklist, type ChecklistItem } from './Checklist'
import { NoCase, NotRecordedHere } from './NotLvo'

/** A disagreement is a registered clinician's, and says enough to learn from. */
const MIN_REASON = 10

export function EvtPage() {
  const { id, strokeCase: c } = useStrokeCaseParam()
  if (!c) return <NoCase screenId="S-18-18" id={id} />
  if (!isIndexCase(c)) return <NotRecordedHere key={c.id} c={c} screenId="S-18-18" heading="EVT selection" pathwayKey="thrombectomy" />
  return <Selection key={c.id} c={c} />
}

function Selection({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const caseNow = useCaseClock()
  const evtDisagreement = useStroke((s) => s.evtDisagreement)
  const recordEvtDisagreement = useStroke((s) => s.recordEvtDisagreement)
  const p = patient(c.patientId)

  const [disagreeOpen, setDisagreeOpen] = useState(false)
  const [disagreeBy, setDisagreeBy] = useState('Dr. Rohit Desai')
  const [disagreeReason, setDisagreeReason] = useState('')
  const [selected, setSelected] = useState(false)

  const blocking = EVT_CRITERIA.filter((x) => isBlocking(x.state))
  const evtTariff = tariff('SD-M-08')
  const items: ChecklistItem[] = EVT_CRITERIA.map((crit) => ({
    key: crit.key,
    label: crit.label,
    answer: <span className="tabular-nums">{crit.answer}</span>,
    consequence: crit.consequence,
    state: crit.state,
  }))
  const to = { perfusion: `/stroke/case/${c.id}/perfusion`, transfer: `/stroke/case/${c.id}/transfer` }
  const closeDialog = () => {
    setDisagreeOpen(false)
    setDisagreeReason('')
  }

  return (
    <ScreenFrame
      screenId="S-18-18"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="EVT selection"
      sub={`${items.length - blocking.length} of ${items.length} criteria clear · ${blocking.length > 0 ? `${blocking.length} outstanding` : 'ready to select'}`}
      chips={
        evtDisagreement && (
          <PillTag tone="warn" size="sm" icon={MessageSquareWarning}>
            disagreement recorded
          </PillTag>
        )
      }
      actions={
        may(to.perfusion) && (
          <Pill variant="card" size="xl" icon={Activity} iconSize={17} onClick={() => navigate(to.perfusion)}>
            Perfusion
          </Pill>
        )
      }
      railTitle="Decision"
      rail={
        <div className="flex flex-col gap-[12px]">
          <Card
            titleSize="sm"
            title="Cost"
            right={
              <PillTag tone="norm" size="sm" icon={Check}>
                never blocking
              </PillTag>
            }
          >
            <dl className="flex flex-col divide-y divide-sh-line">
              <KeyValue label="Self-pay">
                <span className="tabular-nums">{formatRupees(evtTariff.selfPay)}</span>
              </KeyValue>
              <KeyValue label="PM-JAY (HBP)">
                <span className="tabular-nums">{evtTariff.pmjay ? formatRupees(evtTariff.pmjay) : '⊘'}</span>
              </KeyValue>
              <KeyValue label="TPA negotiated">
                <span className="tabular-nums">{formatRupees(evtTariff.tpa)}</span>
              </KeyValue>
            </dl>
            <p className="mt-[10px] text-[13px] text-sh-text-3">The pre-authorisation runs in parallel.</p>
          </Card>
          <Why label="Why a disagreement is recorded">
            <p>
              A neurologist and an interventionist can read the same perfusion map differently, and both can be reasonable. Recording the disagreement is how the registry learns
              which reading was right — a record that shows unanimity it did not have teaches nobody anything.
            </p>
          </Why>
        </div>
      }
      actionBar={
        <>
          <Pill variant="control" size="bar" icon={MessageSquareWarning} onClick={() => setDisagreeOpen(true)}>
            Record a disagreement
          </Pill>
          <span className="text-[13px] text-sh-text-3">{blocking.length > 0 ? `${blocking.length} criterion outstanding` : 'Criteria met'}</span>
          <Pill
            variant="primary"
            size="bar"
            icon={Route}
            className="ml-auto"
            disabled={blocking.length > 0 || selected}
            onClick={() => {
              setSelected(true)
              toast({ tone: 'success', title: 'Selected for thrombectomy', detail: `${me.name} at ${formatTime(caseNow)}. The cath lab reservation moves to the transfer screen.` })
              if (may(to.transfer)) navigate(to.transfer)
            }}
          >
            {selected ? 'Selected' : 'Select for thrombectomy'}
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {evtDisagreement && (
          <Alert tone="warn" icon={MessageSquareWarning} title={`Disagreement recorded by ${evtDisagreement.by}`}>
            “{evtDisagreement.reason}” — recorded at {formatTime(evtDisagreement.at)}. It sits alongside the decision in the case record and in the registry export.
          </Alert>
        )}
        <section className="flex flex-col gap-[10px]" aria-labelledby="evt-criteria-h">
          <h2 id="evt-criteria-h" className="text-[17px] font-medium text-sh-text">
            Selection criteria
          </h2>
          <Checklist items={items} label="EVT selection criteria" />
        </section>
      </div>

      <ConfirmDialog
        open={disagreeOpen}
        title="Record a disagreement"
        consequence="This is recorded against the decision and travels with it into the registry. It does not block the decision or require it to be revisited — it makes the record honest about how the decision was reached."
        confirmLabel="Record it"
        confirmDisabled={disagreeReason.trim().length < MIN_REASON}
        onConfirm={() => {
          if (disagreeReason.trim().length < MIN_REASON) return
          recordEvtDisagreement(disagreeBy, disagreeReason.trim())
          toast({ tone: 'info', title: 'Disagreement recorded', detail: `${disagreeBy} · ${formatTime(caseNow)}` })
          closeDialog()
        }}
        onCancel={closeDialog}
      >
        <div className="flex flex-col gap-[12px]">
          <Select value={disagreeBy} onChange={(e) => setDisagreeBy(e.target.value)} aria-label="Who disagrees">
            {STAFF.filter((s) => s.identifierKind === 'HPR').map((s) => (
              <option key={s.id} value={s.name}>
                {s.name} · {s.personaLabel}
              </option>
            ))}
          </Select>
          <TextArea
            rows={3}
            aria-label="What they read differently"
            value={disagreeReason}
            onChange={(e) => setDisagreeReason(e.target.value)}
            placeholder="What they read differently, and why — at least ten characters…"
          />
        </div>
      </ConfirmDialog>
    </ScreenFrame>
  )
}
