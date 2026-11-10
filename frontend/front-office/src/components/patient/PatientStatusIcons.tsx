import type { LucideIcon } from 'lucide-react'
import { BedDouble, HeartPulse, Siren, Stethoscope, Video } from 'lucide-react'
import { cn } from '../../utils/cn'
import { TONE_STYLES } from '../../utils/tone'
import type { Tone } from '../../utils/tone'
import type { PatientCareStatus } from '../../domain/patientSelectors'
import { formatTime } from '../../domain/time'

interface Mark {
  icon: LucideIcon
  tone: Tone
  /** Tooltip and screen-reader text. */
  label: string
  /** Short text shown beside the icon when details are on. */
  detail: string
}

function marksFor(status: PatientCareStatus): Mark[] {
  const marks: Mark[] = []
  const { admitted, outpatient } = status
  if (admitted) {
    const icon = admitted.ward === 'ICU' ? HeartPulse : admitted.ward === 'Emergency' ? Siren : BedDouble
    const label = admitted.critical ? `${admitted.ward} · ${admitted.bed}` : `Inpatient · ${admitted.ward} · ${admitted.bed}`
    marks.push({ icon, tone: admitted.critical ? 'critical' : 'info', label, detail: admitted.bed })
  }
  if (outpatient) {
    const when = outpatient.token ? `Token ${outpatient.token}` : outpatient.time ? formatTime(outpatient.time) : null
    const teleconsult = outpatient.mode === 'Teleconsult'
    marks.push({
      icon: teleconsult ? Video : Stethoscope,
      tone: teleconsult ? 'purple' : 'teal',
      label: [teleconsult ? 'Teleconsult' : 'Outpatient (OPD)', outpatient.doctor, when].filter(Boolean).join(' · '),
      detail: outpatient.token ?? (outpatient.time ? formatTime(outpatient.time) : 'OPD'),
    })
  }
  return marks
}

/**
 * Where the patient is in care, beside their name: ICU (red heart), Emergency
 * (red siren), inpatient (blue bed), outpatient today (teal stethoscope) and
 * teleconsult today (purple video).
 * Each icon names itself in a tooltip and to screen readers; `showDetail`
 * adds the bed or the time beside the icon.
 */
export function PatientStatusIcons({
  status,
  showDetail = false,
  className,
}: {
  status: PatientCareStatus | undefined
  showDetail?: boolean
  className?: string
}) {
  const marks = status ? marksFor(status) : []
  if (marks.length === 0) return null
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      {marks.map(({ icon: Icon, tone, label, detail }) => (
        <span
          key={label}
          title={label}
          className={cn(
            'inline-flex h-5 items-center gap-1 rounded-full text-2xs font-semibold tabular-nums',
            TONE_STYLES[tone].bg,
            TONE_STYLES[tone].text,
            showDetail ? 'px-1.5' : 'w-5 justify-center',
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">{label}</span>
          {showDetail ? <span aria-hidden="true">{detail}</span> : null}
        </span>
      ))}
    </span>
  )
}
