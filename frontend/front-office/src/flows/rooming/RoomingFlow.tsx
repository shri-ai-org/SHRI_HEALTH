import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DoorOpen } from 'lucide-react'
import { FlowSheet } from '../../components/flow/FlowSheet'
import { AckCard } from '../../components/flow/AckCard'
import { Quadrant, StepRail, SummaryItem, Waiting } from '../../components/flow/Quadrant'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { FieldError } from '../../components/patient/AgeConfirm'
import { useStoreValue } from '../../hooks/useStore'
import { getAppointmentById, getPatientById, getProviderById } from '../../domain/selectors'
import { formatTime, todayKey } from '../../domain/time'
import { cn } from '../../utils/cn'
import { errorClass, inputClass, labelClass } from '../../utils/formClasses'
import type { FlowProps } from '../registry'
import { EMPTY_VITALS, toVitalEntries, type VitalsErrors, type VitalsForm } from '../../../../src/features/clinical/vitals'
import {
  addAllergyEntry,
  addMedicationEntry,
  allergyLabel,
  loadRooming,
  markRoomed,
  medicationLabel,
  saveVitals,
  useMayRoom,
  type RoomingVisit,
} from '../../../shri-health/rooming'
import { newIdempotencyKey, problemMessage } from '../../../shri-health/client'
import { loadAppointments } from '../../../shri-health/scheduling'

/** The vitals the medical assistant takes at rooming, in U.S. units (src/features/clinical/vitals.ts). */
// No example numbers in the boxes: an example reading could be taken for a recorded one.
const VITAL_FIELDS: Array<{ field: keyof VitalsForm; label: string; unit: string }> = [
  { field: 'heartRate', label: 'Heart rate', unit: 'bpm' },
  { field: 'temperature', label: 'Temperature', unit: '°F' },
  { field: 'oxygenSaturation', label: 'SpO2', unit: '%' },
  { field: 'weight', label: 'Weight', unit: 'lb' },
  { field: 'height', label: 'Height', unit: 'in' },
]

/**
 * Rooming (demo step 6; Minalini's exception of 2026-11-10): care-entry's sheet, opened from a
 * checked-in Outpatients row by the medical assistant. The room, the vitals, the allergy review and
 * the medication review, then the visit is marked roomed. Data: `shri-health/rooming.ts`.
 */
export function RoomingFlow({ params, onClose }: FlowProps) {
  const appointment = useStoreValue(getAppointmentById, params.appointment ?? '')
  const patient = useStoreValue(getPatientById, appointment?.patientId ?? '')
  const provider = useStoreValue(getProviderById, appointment?.providerId ?? '')
  const mayRoom = useMayRoom()
  const appointmentId = appointment?.appointmentId ?? ''

  const [visit, setVisit] = useState<RoomingVisit | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [room, setRoom] = useState('')
  const [vitals, setVitals] = useState<VitalsForm>(EMPTY_VITALS)
  const [vitalErrors, setVitalErrors] = useState<VitalsErrors>({})
  const [vitalsSaved, setVitalsSaved] = useState(false)
  const [allergyText, setAllergyText] = useState('')
  const [allergiesReviewed, setAllergiesReviewed] = useState(false)
  const [medText, setMedText] = useState('')
  const [medDose, setMedDose] = useState('')
  const [medsReviewed, setMedsReviewed] = useState(false)
  const [busy, setBusy] = useState<'vitals' | 'allergy' | 'nka' | 'med' | 'room' | null>(null)
  const [error, setError] = useState<{ where: 'vitals' | 'allergies' | 'meds' | 'room'; message: string } | null>(null)
  const [done, setDone] = useState(false)
  // One key per write, kept while that write is retried.
  const keys = useRef<Record<string, string>>({})
  const keyFor = (what: string) => (keys.current[what] ??= newIdempotencyKey())
  const settle = (what: string) => delete keys.current[what]

  useEffect(() => {
    if (!appointmentId || !mayRoom) return
    let live = true
    loadRooming(appointmentId)
      .then((v) => {
        if (!live) return
        setVisit(v)
        setRoom((r) => r || v.rooms[0]?.id || '')
      })
      .catch((e: unknown) => live && setLoadError(problemMessage(e)))
    return () => {
      live = false
    }
  }, [appointmentId, mayRoom])

  const subtitle = patient ? `${patient.name} · ${patient.uhid}` : 'Visit'
  const sheet = (body: ReactNode, footer?: ReactNode) => (
    <FlowSheet title="Room patient" subtitle={subtitle} icon={DoorOpen} iconTone="teal" onClose={onClose} footer={footer}>
      {body}
    </FlowSheet>
  )

  if (!appointment || !patient) return sheet(<Alert tone="warning">That visit no longer exists.</Alert>)
  if (!mayRoom) return sheet(<Alert tone="warning">Only a medical assistant or a nurse can room a patient.</Alert>)
  if (appointment.status !== 'Checked-in') return sheet(<Alert tone="warning">Check the patient in first; only a checked-in visit can be roomed.</Alert>)
  if (loadError) return sheet(<Alert tone="critical" live>The visit could not be loaded. {loadError}</Alert>)
  if (!visit) return sheet(<Waiting>Loading the visit…</Waiting>)

  if (done) {
    return sheet(
      <div className="flex min-h-full items-center justify-center py-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-surface-1 px-6 shadow-card">
          <AckCard title="Roomed" icon={DoorOpen} onDone={onClose}>
            <p className="text-base font-semibold text-ink">{patient.name}</p>
            <p>{visit.rooms.find((r) => r.id === room)?.name ?? 'Roomed'} · ready for {provider?.name ?? 'the provider'}</p>
          </AckCard>
        </div>
      </div>,
    )
  }

  const current = visit
  async function run(what: NonNullable<typeof busy>, where: NonNullable<typeof error>['where'], action: () => Promise<void>) {
    setBusy(what)
    setError(null)
    try {
      await action()
      settle(what)
    } catch (e) {
      setError({ where, message: problemMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  function onSaveVitals() {
    const { entries, errors } = toVitalEntries(vitals)
    setVitalErrors(errors)
    if (Object.keys(errors).length > 0) return
    if (entries.length === 0) {
      setError({ where: 'vitals', message: 'Enter at least one vital sign.' })
      return
    }
    void run('vitals', 'vitals', async () => {
      await saveVitals(current.encounterId, entries, keyFor('vitals'))
      setVitalsSaved(true)
    })
  }

  function onAddAllergy(noneKnown: boolean) {
    if (!noneKnown && !allergyText.trim()) return
    void run(noneKnown ? 'nka' : 'allergy', 'allergies', async () => {
      const added = await addAllergyEntry(current, noneKnown ? null : allergyText, keyFor(noneKnown ? 'nka' : 'allergy'))
      setVisit({ ...current, allergies: [...current.allergies, added] })
      setAllergyText('')
      setAllergiesReviewed(true)
    })
  }

  function onAddMedication() {
    if (!medText.trim()) return
    void run('med', 'meds', async () => {
      const added = await addMedicationEntry(current, medText, medDose, keyFor('med'))
      setVisit({ ...current, medications: [...current.medications, added] })
      setMedText('')
      setMedDose('')
      setMedsReviewed(true)
    })
  }

  function onRoom() {
    void run('room', 'room', async () => {
      await markRoomed(appointmentId, room || undefined, keyFor('room'))
      void loadAppointments(todayKey(), 1).catch(() => undefined)
      setDone(true)
    })
  }

  const steps = [
    { label: 'Room', done: Boolean(room), target: 'rooming-room' },
    { label: 'Vitals', done: vitalsSaved, target: 'rooming-vitals' },
    { label: 'Allergies', done: allergiesReviewed, target: 'rooming-allergies' },
    { label: 'Medications', done: medsReviewed, target: 'rooming-medications' },
  ]
  const currentIndex = steps.findIndex((s) => !s.done)
  const rail = steps.map((s, i) => ({ ...s, current: i === currentIndex }))
  const errorIn = (where: NonNullable<typeof error>['where']) =>
    error?.where === where ? (
      <Alert tone="critical" live>
        {error.message}
      </Alert>
    ) : null

  const footer = (
    <div className="flex flex-col gap-2.5">
      {errorIn('room')}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">{vitalsSaved && allergiesReviewed && medsReviewed ? 'Ready to room.' : 'Vitals, allergies and medications first, where the patient allows.'}</p>
        <Button size="lg" onClick={onRoom} disabled={busy !== null}>
          <DoorOpen className="h-4 w-4" strokeWidth={1.75} />
          {busy === 'room' ? 'Rooming…' : 'Mark roomed'}
        </Button>
      </div>
    </div>
  )

  return sheet(
    <div className="flex flex-col gap-3 sm:gap-4">
      <StepRail steps={rail} />

      <Quadrant id="rooming-room" step={1} title="Room" done={Boolean(room)} current={currentIndex === 0}>
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[1fr_1fr]">
          <dl className="grid grid-cols-2 gap-3">
            <SummaryItem label="Provider" value={provider?.name ?? null} />
            <SummaryItem label="Booked" value={formatTime(appointment.slot)} />
          </dl>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="rooming-room-select" className={labelClass}>
              Exam room
            </label>
            <select id="rooming-room-select" value={room} onChange={(e) => setRoom(e.target.value)} className={inputClass}>
              {current.rooms.length === 0 ? <option value="">No rooms set up</option> : null}
              {current.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Quadrant>

      <Quadrant id="rooming-vitals" step={2} title="Vitals" done={vitalsSaved} current={currentIndex === 1}>
        <div className="flex flex-col gap-3">
          {errorIn('vitals')}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <span className={labelClass}>Blood pressure (mmHg)</span>
              <div className="flex items-center gap-1.5">
                <input aria-label="Systolic" inputMode="numeric" placeholder="Systolic" value={vitals.systolic} disabled={vitalsSaved} onChange={(e) => setVitals({ ...vitals, systolic: e.target.value })} className={cn(inputClass, vitalErrors.systolic && errorClass)} />
                <span className="text-ink-subtle">/</span>
                <input aria-label="Diastolic" inputMode="numeric" placeholder="Diastolic" value={vitals.diastolic} disabled={vitalsSaved} onChange={(e) => setVitals({ ...vitals, diastolic: e.target.value })} className={cn(inputClass, vitalErrors.diastolic && errorClass)} />
              </div>
              <FieldError message={vitalErrors.systolic ?? vitalErrors.diastolic ?? null} />
            </div>
            {VITAL_FIELDS.map((v) => (
              <div key={v.field} className="flex flex-col gap-1.5">
                <label htmlFor={`rooming-${v.field}`} className={labelClass}>
                  {v.label} ({v.unit})
                </label>
                <input id={`rooming-${v.field}`} inputMode="decimal" value={vitals[v.field]} disabled={vitalsSaved} onChange={(e) => setVitals({ ...vitals, [v.field]: e.target.value })} className={cn(inputClass, vitalErrors[v.field] && errorClass)} />
                <FieldError message={vitalErrors[v.field] ?? null} />
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            {vitalsSaved ? (
              <p className="text-sm font-medium text-success-fg">Vitals saved to the chart.</p>
            ) : (
              <Button variant="secondary" onClick={onSaveVitals} disabled={busy !== null}>
                {busy === 'vitals' ? 'Saving…' : 'Save vitals'}
              </Button>
            )}
          </div>
        </div>
      </Quadrant>

      <Quadrant id="rooming-allergies" step={3} title="Allergies" done={allergiesReviewed} current={currentIndex === 2}>
        <div className="flex flex-col gap-3">
          {errorIn('allergies')}
          {current.allergies.length === 0 ? (
            <p className="text-sm text-ink-muted">No allergies on the chart yet. Ask the patient.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {current.allergies.map((a) => (
                <li key={a.id} className="rounded-full border border-border-soft bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink">
                  {allergyLabel(a)}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
              <label htmlFor="rooming-allergy" className={labelClass}>
                Add an allergy
              </label>
              <input id="rooming-allergy" value={allergyText} maxLength={200} placeholder="Penicillin, say" onChange={(e) => setAllergyText(e.target.value)} className={inputClass} />
            </div>
            <Button variant="secondary" onClick={() => onAddAllergy(false)} disabled={busy !== null || !allergyText.trim()}>
              {busy === 'allergy' ? 'Adding…' : 'Add'}
            </Button>
            <Button variant="outline" onClick={() => onAddAllergy(true)} disabled={busy !== null}>
              {busy === 'nka' ? 'Recording…' : 'No known allergies'}
            </Button>
            {!allergiesReviewed && current.allergies.length > 0 ? (
              <Button variant="ghost" onClick={() => setAllergiesReviewed(true)} disabled={busy !== null}>
                Reviewed, no change
              </Button>
            ) : null}
          </div>
        </div>
      </Quadrant>

      <Quadrant id="rooming-medications" step={4} title="Medications" done={medsReviewed} current={currentIndex === 3}>
        <div className="flex flex-col gap-3">
          {errorIn('meds')}
          {current.medications.length === 0 ? (
            <p className="text-sm text-ink-muted">No medications on the chart yet. Ask what the patient takes.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-ink">
              {current.medications.map((m) => (
                <li key={m.id}>{medicationLabel(m)}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-[10rem] flex-1 flex-col gap-1.5">
              <label htmlFor="rooming-med" className={labelClass}>
                Add a medication
              </label>
              <input id="rooming-med" value={medText} maxLength={200} placeholder="Lisinopril 10 mg, say" onChange={(e) => setMedText(e.target.value)} className={inputClass} />
            </div>
            <div className="flex min-w-[8rem] flex-1 flex-col gap-1.5">
              <label htmlFor="rooming-med-dose" className={labelClass}>
                How they take it
              </label>
              <input id="rooming-med-dose" value={medDose} maxLength={200} placeholder="Once a day" onChange={(e) => setMedDose(e.target.value)} className={inputClass} />
            </div>
            <Button variant="secondary" onClick={onAddMedication} disabled={busy !== null || !medText.trim()}>
              {busy === 'med' ? 'Adding…' : 'Add'}
            </Button>
            {!medsReviewed ? (
              <Button variant="ghost" onClick={() => setMedsReviewed(true)} disabled={busy !== null}>
                {current.medications.length > 0 ? 'Reviewed, no change' : 'Takes none'}
              </Button>
            ) : null}
          </div>
        </div>
      </Quadrant>
    </div>,
    footer,
  )
}
