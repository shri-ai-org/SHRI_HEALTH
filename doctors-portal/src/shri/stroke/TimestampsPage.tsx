/**
 * S-18-08 · Timestamps — `/stroke/case/:id/events` (`src/screens/m18/
 * S1808.tsx`): "When two clocks disagree about the door time."
 *
 * DD-012 is the whole screen: local times are RECONCILED AGAINST THE SERVER
 * CLOCK, NEVER TRUSTED — and a disputed door time is a disputed
 * door-to-needle. Corrections are audited amendments, never overwrites, so
 * the original sources stay beside the resolved value. The unresolved slice
 * opens by default (`?scope=`); tonight it is empty and says so; the resolved
 * conflicts are one tap away with their source tables intact.
 *
 * Where the old screen fell short: an amendment under ten characters was
 * silently ignored (Append waits for ten now, and says so), and an appended
 * amendment was kept nowhere and wrote no record (it is listed under its
 * conflict and audited); the empty slice called both conflicts "door-time"
 * conflicts (one is CT start); the index case's conflicts and stream were
 * drawn on every case; an unknown case id threw.
 */

import { Check, Clock, PenLine, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { TIMESTAMP_CONFLICTS, type StrokeCase } from '@/data/stroke'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { minutesBetween, useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock } from '../logic/caseClock'
import { useScope } from '../logic/scope'
import { useStrokeActions } from '../logic/strokeActions'
import { isIndexCase, useStrokeCaseParam } from '../logic/strokeCase'
import { useForcedState } from '../state/ai'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { Field, TextArea } from '../ui/forms'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { Table, Td, Th, Tr } from '../ui/Table'

import { CaseClockStrip } from './CaseClockStrip'
import { NoStream, NoSuchCase } from './StrokeBits'
import { useStrokeLocal } from './strokeLocal'

const AUTHORITY_TONE = { server: 'norm', device: 'pend', local: 'warn' } as const
const AUTHORITY_NOTE = {
  server: 'Authoritative. Recorded by the system, not by a person or a device.',
  device: 'Trusted for its own event. A DICOM header is the modality saying when it fired.',
  local: 'Recorded, never trusted as authoritative. Reconciled against the server.',
} as const

type Scope = 'unresolved' | 'resolved'
const SCOPES: readonly Scope[] = ['unresolved', 'resolved']
type Conflict = (typeof TIMESTAMP_CONFLICTS)[number]

const spread = (x: Conflict) =>
  minutesBetween(x.sources.reduce((a, b) => (a.value < b.value ? a : b)).value, x.sources.reduce((a, b) => (a.value > b.value ? a : b)).value)

export function TimestampsPage() {
  const { id, strokeCase } = useStrokeCaseParam()
  if (!strokeCase) return <NoSuchCase screenId="S-18-08" id={id} />
  return <Timestamps key={strokeCase.id} c={strokeCase} />
}

function Timestamps({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const forced = useForcedState()
  const caseNow = useCaseClock()
  useStrokeActions() // writes the pending stamps once the device is back online
  const allStamps = useStroke((s) => s.stamps)
  const allAmendments = useStrokeLocal((s) => s.amendments)
  const amend = useStrokeLocal((s) => s.amend)
  const [scope, setScope] = useScope(SCOPES, 'unresolved')
  const [amending, setAmending] = useState<string | null>(null)
  const [rationale, setRationale] = useState('')

  const p = patient(c.patientId)
  const own = isIndexCase(c)
  const conflicts = own ? TIMESTAMP_CONFLICTS : []
  const stamps = own ? allStamps : []
  /** A conflict is resolved once a server-reconciled value has been chosen. */
  const resolved = conflicts.filter((x) => Boolean(x.resolved))
  const unresolved = conflicts.filter((x) => !x.resolved)
  const shown = scope === 'unresolved' ? unresolved : resolved
  const ready = rationale.trim().length >= 10
  const clock = `/stroke/case/${c.id}/clock`

  function close() {
    setAmending(null)
    setRationale('')
  }

  function append() {
    if (!amending || !ready) return
    amend({ event: amending, rationale: rationale.trim(), at: caseNow, by: me.name })
    audit({
      event: 'STROKE.TIMESTAMP_AMENDED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      at: caseNow.toISOString(),
      detail: `${c.caseNo} · ${amending} · “${rationale.trim()}”`,
      ...(forced === 'OFFLINE' ? { queued: true } : {}),
    })
    toast({ tone: 'info', title: 'Amendment appended', detail: `${me.name} · ${formatTime(caseNow)}. Dependent intervals recomputed.` })
    close()
  }

  return (
    <ScreenFrame
      screenId="S-18-08"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Timestamps"
      sub={`${unresolved.length} unresolved · ${resolved.length} resolved · ${stamps.length} stamped this session`}
      actions={
        may(clock) && (
          <Pill variant="card" size="xl" icon={Clock} iconSize={17} onClick={() => navigate(clock)}>
            Case clock
          </Pill>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-[20px]">
        {own ? (
          <>
            <Segmented
              label="Which to show"
              value={scope}
              onChange={setScope}
              options={[
                { key: 'unresolved', label: 'Unresolved', icon: TriangleAlert, count: unresolved.length },
                { key: 'resolved', label: 'Resolved', icon: Check, count: resolved.length },
              ]}
            />

            {shown.length === 0 && (
              <Card titleSize="sm" title={scope === 'unresolved' ? 'Unresolved' : 'Resolved'}>
                <p className="flex items-center gap-[8px] text-[14px] text-sh-text-2">
                  <Icon icon={Check} size={15} className="text-sh-norm-fg" />
                  {scope === 'unresolved' ? (resolved.length === 2 ? 'Both timestamp conflicts are resolved.' : `All ${resolved.length} timestamp conflicts are resolved.`) : 'No conflict has been resolved on this case yet.'}
                </p>
              </Card>
            )}

            {shown.map((x) => {
              const amendments = allAmendments.filter((a) => a.event === x.event)
              return (
                <Card
                  key={x.event}
                  titleSize="sm"
                  title={x.event}
                  headerClassName="flex-wrap"
                  right={
                    <>
                      <span className="text-[13px] tabular-nums text-sh-text-2">
                        {x.sources.length} sources · {spread(x)} min apart
                      </span>
                      <Pill variant="control" size="lg" icon={PenLine} onClick={() => setAmending(x.event)}>
                        Amend with a reason
                      </Pill>
                    </>
                  }
                >
                  <div className="grid min-w-0 gap-[12px] md:grid-cols-[minmax(0,1fr)_256px]">
                    {/* The disagreeing sources. */}
                    <Table
                      caption={`${x.event} sources`}
                      head={
                        <>
                          <Th>Source</Th>
                          <Th>Time</Th>
                          <Th>Authority</Th>
                        </>
                      }
                    >
                      {x.sources.map((s) => (
                        <Tr key={s.source} className={cn(s.value.getTime() === x.resolved.getTime() && 'bg-sh-norm-bg')}>
                          <Td>{s.source}</Td>
                          <Td className="font-semibold tabular-nums">{formatTime(s.value)}</Td>
                          <Td>
                            <PillTag tone={AUTHORITY_TONE[s.authority]} size="sm" title={AUTHORITY_NOTE[s.authority]}>
                              {s.authority}
                            </PillTag>
                          </Td>
                        </Tr>
                      ))}
                    </Table>
                    {/* The resolution, beside the sources it came from. */}
                    <div className="rounded-[16px] bg-sh-inner px-[16px] py-[12px]">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Resolved</p>
                      <p className="mt-[4px] text-[24px] font-bold tabular-nums">{formatTime(x.resolved)}</p>
                      <p className="mt-[4px] flex items-center gap-[6px] text-[13px] font-medium text-sh-norm-fg">
                        <Icon icon={Check} size={13} />
                        {x.resolvedBy}
                      </p>
                      <p className="mt-[8px] text-[13px] text-sh-text-2">{x.consequence}</p>
                    </div>
                  </div>
                  {amendments.length > 0 && (
                    <ul aria-label={`${x.event} amendments`} className="mt-[12px] flex flex-col divide-y divide-(--line) rounded-[16px] bg-sh-inner px-[14px]">
                      {amendments.map((a, i) => (
                        <li key={i} className="py-[10px] text-[14px]">
                          <p className="text-sh-text">{a.rationale}</p>
                          <p className="mt-[2px] text-[12px] tabular-nums text-sh-text-2">
                            Amendment appended by {a.by} · {formatTime(a.at)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )
            })}
          </>
        ) : (
          <Card>
            <NoStream caseNo={c.caseNo} what="timestamp conflicts" />
          </Card>
        )}

        {/* The append-only stream, including stamps made this session. */}
        <Card titleSize="sm" title="Event stream" right={<span className="text-[13px] text-sh-text-2">append-only</span>} className="overflow-hidden">
          {stamps.length === 0 ? (
            <p className="text-[14px] text-sh-text-2">Nothing stamped yet in this session. Stamping happens on the case clock, one keystroke each.</p>
          ) : (
            <Table
              caption="Case event stream"
              rowCount={`${stamps.length} stamps this session · server time ${formatTime(caseNow)}`}
              head={
                <>
                  <Th>Event</Th>
                  <Th>Stamped</Th>
                  <Th>By</Th>
                  <Th>State</Th>
                </>
              }
            >
              {stamps.map((s) => (
                <Tr key={s.key}>
                  <Td className="font-medium">{s.label}</Td>
                  <Td className="tabular-nums">{formatTime(s.at)}</Td>
                  <Td>{s.by}</Td>
                  <Td>
                    <PillTag tone={s.pending ? 'warn' : 'norm'} size="sm" icon={s.pending ? Clock : Check}>
                      {s.pending ? 'pending sync' : 'committed'}
                    </PillTag>
                  </Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>

        <Why label="Which source wins, and why it matters">
          <ul className="flex flex-col gap-[8px]">
            {(['server', 'device', 'local'] as const).map((a) => (
              <li key={a} className="flex items-start gap-[8px]">
                <PillTag tone={AUTHORITY_TONE[a]} size="sm">
                  {a}
                </PillTag>
                <span>{AUTHORITY_NOTE[a]}</span>
              </li>
            ))}
          </ul>
          <p>A five-minute disagreement about the door time moves door-to-needle from 41 to 46 minutes. One of those numbers is inside the target and one is not — which is why the reconciliation is a clinical record rather than a data-quality exercise.</p>
          <p className="text-sh-text-3">Corrections are amendments, never overwrites. A resolved value sits next to the sources it was resolved from; nothing is deleted, and the amendment carries the name of whoever made it.</p>
        </Why>
      </div>

      <ConfirmDialog
        open={amending !== null}
        title={`Amend the ${amending?.toLowerCase()}?`}
        consequence="The original sources and the current resolution both stay visible. Your amendment is appended with your name and the time, and every interval that depends on this timestamp is recomputed and shown as recomputed."
        confirmLabel="Append the amendment"
        confirmDisabled={!ready}
        onConfirm={append}
        onCancel={close}
      >
        <Field label="Why the resolved time is wrong" htmlFor="amend-rationale" hint={ready ? undefined : 'At least ten characters — the amendment is evidence.'}>
          <TextArea
            id="amend-rationale"
            rows={3}
            autoFocus
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why the resolved time is wrong, and what evidence supports the change — at least ten characters…"
          />
        </Field>
      </ConfirmDialog>
    </ScreenFrame>
  )
}
