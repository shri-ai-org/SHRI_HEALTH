/**
 * S-05-04 · Session templates — `/schedule/templates` (`src/screens/m05/
 * S0504.tsx`): "A clinician's recurring session pattern."
 *
 * Effective-dated master data (ARC-18): changing a template does not rewrite
 * the appointments already booked against the old one. The surface opens on
 * today's session; the week is one tap away (`?scope=week`). AI-608's two
 * capacity observations sit in the rail at G1 — they describe how the session
 * has run over twelve weeks, never how it will — and editing by hand stays
 * the fallback.
 */

import { Check, Pencil, Plus, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'

import { NOW, formatTime } from '@/data/format'
import { SESSIONS, type Session } from '@/data/schedule'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { useScope } from '../logic/scope'
import { SuggestionCard } from '../ui/ai'
import { Dialog } from '../ui/Dialog'
import { Why } from '../ui/Disclosure'
import { Field, Select, TextInput } from '../ui/forms'
import { Card, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { Worklist, type WorklistColumn } from '../ui/Worklist'

/** NOW is Mon 21-Sep-2026, so "today" is the Monday pattern. */
const TODAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][NOW.getDay()]
const SCOPES = ['today', 'week'] as const
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export function SessionTemplatesPage() {
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const [effectiveOn, setEffectiveOn] = useState('2026-09-21')
  const [editing, setEditing] = useState<Session | null>(null)
  const [slotMin, setSlotMin] = useState(10)
  const [scope, setScope] = useScope(SCOPES, 'today')
  /** Sessions created here, this device only. */
  const [created, setCreated] = useState<Session[]>([])
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ day: TODAY_NAME, start: '14:00', end: '17:00', slotMin: 15, clinic: '' })
  const allSessions = [...SESSIONS, ...created]

  const today = allSessions.filter((s) => s.day === TODAY_NAME)
  const suggested = allSessions.filter((s) => s.observation)
  const rows = scope === 'today' ? today : allSessions

  function edit(s: Session) {
    setEditing(s)
    setSlotMin(s.slotMin)
  }

  function create() {
    const capacity = Math.max(1, Math.floor((minutes(draft.end) - minutes(draft.start)) / draft.slotMin))
    setCreated((c) => [
      ...c,
      { id: `T-${SESSIONS.length + c.length + 1}`, day: draft.day, start: draft.start, end: draft.end, slotMin: draft.slotMin, clinic: draft.clinic.trim(), capacity, effectiveFrom: effectiveOn },
    ])
    setCreating(false)
    setDraft({ day: TODAY_NAME, start: '14:00', end: '17:00', slotMin: 15, clinic: '' })
    toast({ tone: 'success', title: 'Session created', detail: `${draft.day} ${draft.start}–${draft.end} · ${capacity} slots of ${draft.slotMin} min · from ${effectiveOn}.` })
  }

  const columns: WorklistColumn<Session>[] = [
    { key: 'time', label: 'Time', role: 'lead', cell: (s) => `${s.start}–${s.end}` },
    { key: 'clinic', label: 'OPD', role: 'primary', cell: (s) => s.clinic },
    { key: 'day', label: 'Day', role: 'context', cell: (s) => s.day },
    { key: 'slot', label: 'Slot', role: 'context', cell: (s) => <span className="tabular-nums">{s.slotMin}-min slots</span> },
    { key: 'capacity', label: 'Capacity', role: 'context', cell: (s) => <span className="tabular-nums">{s.capacity} patients</span> },
    {
      key: 'effective',
      label: 'Effective from',
      role: 'status',
      cell: (s) => (
        <span className="flex flex-wrap items-center justify-end gap-[6px]">
          {s.observation && (
            <PillTag tone="warn" size="sm" icon={TriangleAlert}>
              capacity review
            </PillTag>
          )}
          <PillTag tone="neu" size="sm" className="tabular-nums">
            from {s.effectiveFrom}
          </PillTag>
        </span>
      ),
    },
  ]

  const capacityPreview = editing ? Math.floor((minutes(editing.end) - minutes(editing.start)) / slotMin) : 0

  return (
    <ScreenFrame
      screenId="S-05-04"
      heading="Session templates"
      sub={`${today.length} session today · ${allSessions.length} this week${suggested.length > 0 ? ` · ${suggested.length} capacity suggestions` : ''}`}
      actions={
        <>
          <TextInput type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} className="h-[46px] w-auto" aria-label="Effective on" />
          <Pill variant="primary" size="xl" icon={Plus} onClick={() => setCreating(true)}>
            New session
          </Pill>
        </>
      }
      rail={
        <div className="flex flex-col gap-[12px]">
          {suggested.map((s) => (
            <SuggestionCard
              key={s.id}
              touchpointId={`template:${s.id}`}
              capabilityId="AI-608"
              title={`${s.day} ${s.start} — ${s.capacity > 12 ? 'over-booked' : 'under-booked'}`}
              evidence={s.observation!}
              band={s.observationBand ?? 'MED'}
              score={s.observationConfidence}
              gate="G1"
              explain={{
                touchpointId: `template:${s.id}`,
                capabilityId: 'AI-608',
                claim: `The ${s.day} ${s.start} template does not match how the session actually runs.`,
                confidence: s.observationConfidence ?? 0.75,
                band: s.observationBand ?? 'MED',
                computedAt: formatTime(NOW),
                inputs: [
                  { label: 'Session start and finish times, 12 weeks', source: 'Clinic session history' },
                  { label: 'Consultation durations', source: 'Encounter records' },
                  { label: 'Did-not-attend rate for this session', source: 'Appointment book' },
                ],
                evidence: [s.observation!],
                model: 'capacity-opt v2.2.0',
                limits: ['Observes the past. A change in case mix makes it wrong until it has re-learned.', 'It does not know which overruns were worth having.', 'Manual template editing is the fallback.'],
              }}
            />
          ))}
        </div>
      }
      railTitle="Capacity"
      railBadge={suggested.length}
    >
      <div className="flex max-w-[896px] flex-col gap-[16px]">
        <Worklist
          rows={rows}
          columns={columns}
          rowKey={(s) => s.id}
          onOpen={edit}
          rowAction={(s) => (
            <Pill variant="control" size="lg" icon={Pencil} onClick={() => edit(s)} aria-label={`Edit ${s.day} ${s.start}–${s.end}`}>
              Edit
            </Pill>
          )}
          caption={`Weekly session pattern · effective on ${effectiveOn} · ${me.name}`}
          noun="sessions"
          emptyWhy={scope === 'today' ? `No session is templated for ${TODAY_NAME}. The week's pattern is one tap away.` : 'No sessions are templated yet. A new session would appear here.'}
          emptyAction={
            scope === 'today' ? (
              <Pill variant="control" size="lg" onClick={() => setScope('week')}>
                Show this week
              </Pill>
            ) : undefined
          }
          filters={
            <Segmented
              label="Which sessions"
              value={scope}
              onChange={setScope}
              options={[
                { key: 'today', label: 'Today', count: today.length },
                { key: 'week', label: 'This week', count: allSessions.length },
              ]}
            />
          }
        />

        <Why label="Why a change is never retrospective">
          <p>
            Editing a template creates a new version effective from a date you choose. Appointments already booked keep the template they were booked against — a patient does not
            lose their slot because the pattern changed.
          </p>
          <p className="text-sh-text-3">Shortening a slot raises capacity but not throughput. If the mean consultation is 11 minutes, ten-minute slots guarantee the session runs late.</p>
        </Why>

        {editing && (
          <Card
            title={`${editing.day} ${editing.start}–${editing.end}`}
            titleSize="sm"
            right={<span className="text-[13px] text-sh-text-3">{editing.clinic}</span>}
            aria-label={`Edit the ${editing.day} template`}
          >
            <div className="grid gap-[16px] sm:grid-cols-3">
              <Field label="Slot length" htmlFor="slot-len">
                <Select id="slot-len" value={String(slotMin)} onChange={(e) => setSlotMin(Number(e.target.value))}>
                  {[10, 12, 15, 20, 30].map((m) => (
                    <option key={m} value={m}>
                      {m} minutes
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Resulting capacity" htmlFor="cap">
                <TextInput id="cap" readOnly value={String(capacityPreview)} />
              </Field>
              <Field label="Effective from" htmlFor="eff-from">
                <TextInput id="eff-from" type="date" defaultValue="2026-10-01" />
              </Field>
            </div>
            <div className="mt-[16px] flex flex-wrap gap-[8px]">
              <Pill
                variant="primary"
                size="lg"
                icon={Check}
                onClick={() => {
                  toast({ tone: 'success', title: `${editing.day} template updated`, detail: 'Effective from 01-Oct-2026. Existing bookings are untouched.' })
                  setEditing(null)
                }}
              >
                Save a new version
              </Pill>
              <Pill variant="control" size="lg" onClick={() => setEditing(null)}>
                Cancel
              </Pill>
            </div>
          </Card>
        )}
      </div>

      <Dialog
        open={creating}
        title="New session template"
        subtitle="A recurring clinic session. Effective from the date in the header."
        onClose={() => setCreating(false)}
        footer={
          <>
            <Pill variant="control" size="lg" icon={X} onClick={() => setCreating(false)}>
              Cancel
            </Pill>
            <Pill variant="primary" size="lg" icon={Check} disabled={draft.clinic.trim().length < 3 || draft.start >= draft.end} onClick={create}>
              Create session
            </Pill>
          </>
        }
      >
        <div className="flex flex-col gap-[12px]">
          <Field label="Clinic" required htmlFor="new-session-clinic">
            <TextInput
              id="new-session-clinic"
              value={draft.clinic}
              onChange={(e) => setDraft((d) => ({ ...d, clinic: e.target.value }))}
              placeholder="General medicine, follow-up only"
              autoFocus
            />
          </Field>
          <Field label="Day" required htmlFor="new-session-day">
            <Select id="new-session-day" value={draft.day} onChange={(e) => setDraft((d) => ({ ...d, day: e.target.value }))}>
              {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-[12px]">
            <Field label="Start" required htmlFor="new-session-start">
              <TextInput id="new-session-start" type="time" value={draft.start} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} />
            </Field>
            <Field label="End" required htmlFor="new-session-end">
              <TextInput id="new-session-end" type="time" value={draft.end} onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} />
            </Field>
            <Field label="Slot" required htmlFor="new-session-slot">
              <Select id="new-session-slot" value={draft.slotMin} onChange={(e) => setDraft((d) => ({ ...d, slotMin: Number(e.target.value) }))}>
                {[10, 15, 20, 30].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Dialog>
    </ScreenFrame>
  )
}
