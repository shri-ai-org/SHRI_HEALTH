/**
 * §7.2 / GP-05 — the patient banner, specified once and drawn by every screen
 * that shows a patient (`src/shell/PatientBanner.tsx`): where a wrong-patient
 * error is caught. Identity on the left — avatar, name, native name, age/sex,
 * then UHID · bed · LOS · consultant — and the flags on the right, each with
 * an icon and a word, never colour alone: the admission's progress, the
 * allergy that gates prescribing, MLC, the payer, ABHA, and the one door into
 * the record from screens that are not the record. Break-glass access puts
 * its amber strip above it, reason first (GP-10).
 */

import { Ban, BedDouble, BookOpen, Check, CircleHelp, CreditCard, Gavel, Hourglass, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { stageLabel } from '@/data/admissions'
import { ageSex } from '@/data/format'
import type { Patient } from '@/data/kit'
import { useAdmissions } from '@/store/admissions'
import { useSession } from '@/store/session'

import { cn } from '../lib/cn'
import { initials } from '../lib/initials'
import { Avatar, Card, Icon, PillTag } from '../ui/primitives'

/** The record's own screens carry their own navigation between its parts, so the door is absent there. */
const ON_RECORD = /^\/patient\/[^/]+(\/(record|condition|results|reports|notes|prescriptions|appointments))?$/

/** The script a native name is written in, so a screen reader reads it in that language. */
function langOf(text: string): string | undefined {
  if (/[஀-௿]/.test(text)) return 'ta'
  if (/[ഀ-ൿ]/.test(text)) return 'ml'
  if (/[ಀ-೿]/.test(text)) return 'kn'
  if (/[ऀ-ॿ]/.test(text)) return 'hi'
  return undefined
}

const TAG = 'h-[30px] px-[11px] text-[13px]'

export function PatientBanner({ patient: p, extra }: { patient: Patient; extra?: ReactNode }) {
  const breakGlass = useSession((s) => s.breakGlassPatients[p.id])
  const admission = useAdmissions((s) => s.admissions[p.id])
  const { pathname } = useLocation()
  const onRecord = ON_RECORD.test(pathname)
  const sub = [p.uhid, p.bed, p.losDays !== undefined ? `LOS ${p.losDays}d` : undefined, p.consultant].filter(Boolean).join(' · ')

  return (
    <div className="flex flex-col gap-[10px]">
      {/* GP-10 — amber, full width, reason before content. */}
      {breakGlass && (
        <div role="status" className="flex min-h-[44px] flex-wrap items-center gap-x-[10px] gap-y-[2px] rounded-[16px] bg-sh-warn-bg px-[16px] py-[8px] text-sh-warn-fg">
          <Icon icon={TriangleAlert} size={16} strokeWidth={2} />
          <span className="text-[13px] font-semibold">Break-glass access — logged and reviewed within 24 hours</span>
          <span className="text-[13px]">you · &ldquo;{breakGlass.reason}&rdquo;</span>
        </div>
      )}
      <Card className="flex-row flex-wrap items-center gap-[16px] px-[20px] py-[16px]" aria-label="Patient">
        {p.unidentified ? (
          <span className="inline-flex size-[56px] shrink-0 items-center justify-center rounded-full bg-sh-warn-bg text-sh-warn-fg" title="Unidentified patient">
            <Icon icon={CircleHelp} size={24} />
          </span>
        ) : (
          <Avatar initials={initials(p.name)} variant="accent" size={56} />
        )}
        <div className="min-w-0 grow basis-[340px]">
          <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[2px]">
            <span className="text-[22px]/[1.2] font-medium tracking-[-0.015em] text-sh-text">{p.name}</span>
            {p.nameNative && (
              <span lang={langOf(p.nameNative)} className="font-sh-tamil text-[15px] font-medium text-sh-text-2">
                {p.nameNative}
              </span>
            )}
            <span className="text-[15px] tabular-nums text-sh-text-2">{ageSex(p.age, p.sex)}</span>
          </div>
          <div className="mt-[3px] text-[13px] tabular-nums text-sh-text-3">{sub}</div>
        </div>

        {/* Below lg the flags take their own row under the name rather than squeezing it. */}
        <ul className="flex flex-wrap items-center justify-end gap-[8px] max-lg:basis-full max-lg:justify-start" aria-label="Flags">
          {/* Where an admission ordered for this patient has got to. Nothing when there is none. */}
          {admission && (
            <li>
              {admission.admittedAt !== undefined ? (
                <PillTag tone="norm" size="sm" icon={BedDouble} className={TAG}>
                  {stageLabel(admission)}
                </PillTag>
              ) : (
                <PillTag tone="warn" size="sm" icon={Hourglass} className={TAG}>
                  Admission in progress · {admission.bed ? `bed ${admission.bed}` : 'waiting for bed'}
                </PillTag>
              )}
            </li>
          )}
          {/* The allergy flag is the one that stops a prescription. */}
          <li>
            {p.allergies.length > 0 ? (
              <PillTag tone="crit" size="sm" icon={Ban} className={cn(TAG, 'font-semibold')} title="Documented allergy — prescribing is gated on this">
                Allergy: {p.allergies.join(', ')}
              </PillTag>
            ) : (
              <PillTag tone="neu" size="sm" icon={Check} className={TAG}>
                No known allergy
              </PillTag>
            )}
          </li>
          {p.mlc && (
            <li>
              <PillTag tone="warn" size="sm" icon={Gavel} className={cn(TAG, 'font-semibold')} title="Medico-legal case — police intimation required">
                MLC
              </PillTag>
            </li>
          )}
          <li>
            <PillTag tone="neu" size="sm" icon={CreditCard} className={TAG}>
              Payer:&nbsp;<b className="font-semibold">{p.payer}</b>
            </PillTag>
          </li>
          {/* GP-09 consent & ABHA chip. */}
          <li>
            <PillTag
              tone={p.abhaStatus === 'Linked' ? 'norm' : 'warn'}
              size="sm"
              icon={p.abhaStatus === 'Linked' ? Check : Info}
              className={cn(TAG, p.abhaStatus === 'Linked' && 'font-semibold')}
              title={p.abha ?? 'No ABHA linked to this record'}
            >
              ABHA {p.abhaStatus}
            </PillTag>
          </li>
          {!onRecord && (
            <li>
              <Link
                to={`/patient/${p.uhid}`}
                className="inline-flex h-[30px] items-center gap-[6px] rounded-full bg-sh-control px-[11px] text-[13px] font-medium text-sh-text transition-colors duration-150 hover:bg-sh-hover-strong"
              >
                <Icon icon={BookOpen} size={14} />
                Patient record
              </Link>
            </li>
          )}
        </ul>
        {extra && <div className="basis-full">{extra}</div>}
      </Card>
    </div>
  )
}
