import type { CSSProperties, ElementType } from 'react'
import { BedDouble, CalendarPlus, Copy, IndianRupee, LogOut } from 'lucide-react'
import { Avatar } from '../ui/Avatar'
import { Badge } from '../ui/Badge'
import { useToast } from '../../hooks/useToast'
import { usePatientCareStatus } from '../../hooks/useCareStatus'
import { PatientStatusIcons } from './PatientStatusIcons'
import { PatientDetailsStrip } from './PatientDetailsCard'
import { initialsOf } from '../../utils/format'
import { cn } from '../../utils/cn'
import type { PatientHeaderSummary } from '../../domain/patientSelectors'
import type { Patient } from '../../types/patient'
import type { Tone } from '../../utils/tone'

const RISK_TONE: Record<'High' | 'Watch' | 'Normal', Tone> = { High: 'critical', Watch: 'warning', Normal: 'info' }
export interface PatientActions {
  schedule: () => void
  admit: () => void
  discharge: () => void
  /** Show or hide the Payment History panel beside the timeline. */
  togglePayments: () => void
}

/**
 * The top of the patient profile — who this is, how to reach them, whether
 * money is owed, whether they are admitted, and the things the desk does
 * for a patient. It stays in view while the timeline scrolls underneath.
 */
export function PatientHeader({
  patient,
  summary,
  actions,
  paymentsOpen = false,
}: {
  patient: Patient
  summary: PatientHeaderSummary
  actions: PatientActions
  paymentsOpen?: boolean
}) {
  const { notify } = useToast()
  const care = usePatientCareStatus()
  const { risk, inpatient } = summary

  function copyUhid() {
    void navigator.clipboard?.writeText(patient.uhid).then(
      () => notify('UHID copied', { detail: patient.uhid }),
      () => notify('Could not copy the UHID', { tone: 'error' }),
    )
  }

  return (
    <header className="-mx-4 -mt-4 border-b border-border-soft bg-bg/95 px-4 py-3.5 backdrop-blur sm:-mx-5 sm:-mt-5 sm:px-5 sm:py-4 xl:-mx-6 xl:px-6 sm:px-6">
      {/* Who the patient is, with the actions level with the name at the top right. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <Avatar name={patient.name} initials={initialsOf(patient.name)} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="truncate text-xl font-semibold tracking-tight text-ink sm:text-2xl">{patient.name}</h1>
              <PatientStatusIcons status={care[patient.patientId]} />
              {/* Only a state worth flagging gets a tag — a plain outpatient has none. */}
              {risk.level !== 'Normal' ? (
                <>
                  <span title={risk.reason}>
                    <Badge tone={RISK_TONE[risk.level]}>{risk.label}</Badge>
                  </span>
                  <span className="sr-only">Risk: {risk.reason}</span>
                </>
              ) : null}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-muted">
              <button
                type="button"
                onClick={copyUhid}
                className="focus-ring -my-2 inline-flex min-h-11 items-center gap-1 rounded-lg font-semibold tabular-nums text-ink hover:text-primary-text"
                title="Copy UHID"
                aria-label={`Copy UHID ${patient.uhid}`}
              >
                {patient.uhid}
                <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
              <span>
                {patient.age ? `${patient.age} yrs` : 'Age —'} · {patient.sex}
              </span>
            </div>
          </div>
        </div>

        {/* Schedule first, then Admit (or Discharge), then Payment History — each in its own colour. */}
        <div className="flex shrink-0 flex-wrap gap-2">
          <Action icon={CalendarPlus} label="Schedule Appointment" hue={HUES.blue} onClick={actions.schedule} />
          {inpatient ? (
            <Action icon={LogOut} label="Discharge" hue={HUES.red} onClick={actions.discharge} />
          ) : (
            <Action icon={BedDouble} label="Admit" hue={HUES.orange} onClick={actions.admit} />
          )}
          <Action
            icon={IndianRupee}
            label="Payment History"
            hue={HUES.green}
            onClick={actions.togglePayments}
            pressed={paymentsOpen}
            title={paymentsOpen ? 'Hide payment history' : 'Show payment history'}
          />
        </div>
      </div>
      {/* Contact and ABHA across the full width, lined up under the name. */}
      <div className="sm:pl-[3.875rem]">
        <PatientDetailsStrip patient={patient} />
      </div>
    </header>
  )
}

/** One clearly different hue per action — blue, orange, green (red for Discharge). */
const HUES = {
  blue: '#2563eb',
  orange: '#ea580c',
  green: '#059669',
  red: '#dc2626',
}

/** A header action in a light tint of its own hue with the hue's text, so the three read apart at a glance; pressed (Payment History open) is a deeper tint with a ring. */
function Action({
  icon: Icon,
  label,
  hue,
  onClick,
  pressed,
  title,
}: {
  icon: ElementType
  label: string
  hue: string
  onClick: () => void
  pressed?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      style={{ '--tone': hue } as CSSProperties}
      className={cn(
        'focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors lg:min-h-10',
        'border-[color-mix(in_oklab,var(--tone)_30%,var(--color-surface-1))] font-semibold text-[color-mix(in_oklab,var(--tone)_85%,var(--color-ink))] shadow-card-sm',
        pressed
          ? 'bg-[color-mix(in_oklab,var(--tone)_26%,var(--color-surface-1))] ring-2 ring-[color-mix(in_oklab,var(--tone)_35%,transparent)] ring-offset-1 ring-offset-[var(--color-surface-1)]'
          : 'bg-[color-mix(in_oklab,var(--tone)_14%,var(--color-surface-1))] hover:bg-[color-mix(in_oklab,var(--tone)_22%,var(--color-surface-1))]',
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}
