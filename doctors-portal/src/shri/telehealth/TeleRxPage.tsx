/**
 * S-27-04 · Tele-prescription and the category gate — `/tele/session/:id/rx`
 * (`src/screens/m27/Telehealth.tsx` S2704). The screen that earns M-27 its
 * place: CMP-DRUG-06 and AI-310 make the prescribing-category gate HARD-CODED
 * and never AI-decided (`logic/tele.ts`). Switching video ↔ telephone changes
 * what is prescribable; a blocked item says why once, on the formulary, and
 * the prescription cannot be signed while it is in the basket.
 */

import { Ban, OctagonAlert, Plus, Signature, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { formatDateTime } from '@/data/format'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { CATEGORIES, CATEGORY_TONE, TELE_FORMULARY, blockedReason, teleParty, type TeleMode } from '../logic/tele'
import { useAiActive } from '../state/ai'
import { Why } from '../ui/Disclosure'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'

import { NoParty } from './NoParty'

export function TeleRxPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  /** Video vs telephone changes what is prescribable. Hard-coded, not a setting. */
  const [mode, setMode] = useState<TeleMode>('video')
  const [basket, setBasket] = useState<string[]>([])

  const party = teleParty(id)
  if (!party) return <NoParty screenId="S-27-04" id={id} />
  const { patient: p, encounter: enc } = party

  const blocked = basket.filter((d) => blockedReason(d, mode) !== null)

  return (
    <ScreenFrame
      screenId="S-27-04"
      patient={p}
      sub={`${mode} consultation${blocked.length > 0 ? ` · ${blocked.length} blocked by the category gate` : ''}`}
      rail={
        <Why label="The four categories">
          <ul className="flex flex-col gap-[10px]">
            {CATEGORIES.map((x) => (
              <li key={x.c}>
                <PillTag tone={CATEGORY_TONE[x.c]} size="sm">
                  List {x.c}
                </PillTag>
                <p className="mt-[4px]">{x.t}</p>
              </li>
            ))}
          </ul>
          <p className="text-sh-text-3">
            Telemedicine Practice Guidelines 2020 · CMP-DRUG-06. The prohibited list is hard-coded and never AI-decided. {aiActive ? 'AI-310' : 'The static list'} decides nothing
            here — it is a regulatory boundary, and it holds with the AI on or off.
          </p>
        </Why>
      }
      railTitle="Category gate"
      actionBar={
        <>
          <Segmented
            label="Consultation mode"
            value={mode}
            onChange={setMode}
            options={[
              { key: 'video', label: 'Video' },
              { key: 'telephone', label: 'Telephone' },
            ]}
          />
          <span className="text-[13px] text-sh-text-3">
            {blocked.length > 0 ? 'Remove the blocked items before signing' : `${basket.length} item${basket.length === 1 ? '' : 's'} · HPR printed on the prescription`}
          </span>
          <Pill
            variant="primary"
            size="bar"
            icon={Signature}
            className="ml-auto"
            disabled={basket.length === 0 || blocked.length > 0}
            onClick={() => {
              toast({ tone: 'success', title: 'Tele-prescription signed', detail: 'Printed bilingually with your HPR number, and published to ABDM.' })
              navigate('/tele/queue')
            }}
          >
            Sign the tele-prescription
          </Pill>
        </>
      }
    >
      <div className="grid gap-[16px] xl:grid-cols-2">
        <Card titleSize="sm" title="Formulary, filtered by mode" className="p-0 [&>header]:px-[18px] [&>header]:pt-[18px]">
          <ul aria-label="Tele-formulary" className="divide-y divide-sh-line">
            {TELE_FORMULARY.map((f) => {
              const reason = blockedReason(f.drug, mode)
              return (
                <li key={f.drug} className={cn('px-[18px] py-[12px]', reason && 'bg-sh-crit-bg/30')}>
                  <div className="flex flex-wrap items-center justify-between gap-[8px]">
                    <p className="flex min-w-0 flex-wrap items-center gap-[8px] font-medium">
                      {f.drug}
                      <PillTag tone={CATEGORY_TONE[f.category]} size="sm" title={f.why}>
                        List {f.category}
                      </PillTag>
                    </p>
                    {reason ? (
                      <PillTag tone="crit" size="sm" icon={Ban}>
                        blocked
                      </PillTag>
                    ) : (
                      <Pill variant="control" size="lg" icon={Plus} disabled={basket.includes(f.drug)} onClick={() => setBasket((b) => [...b, f.drug])} aria-label={`Add ${f.drug}`}>
                        Add
                      </Pill>
                    )}
                  </div>
                  {/* The blocked reason shown once, here — not on the chip title too. */}
                  {reason && (
                    <p className="mt-[8px] flex items-start gap-[8px] rounded-[12px] bg-sh-crit-bg px-[12px] py-[8px] text-[13px] font-medium text-sh-crit-fg">
                      <Icon icon={OctagonAlert} size={13} className="mt-[3px]" />
                      {reason}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>

        <Card titleSize="sm" title="Prescription" className="p-0 [&>header]:px-[18px] [&>header]:pt-[18px]">
          {basket.length === 0 ? (
            <p className="px-[18px] pb-[32px] pt-[16px] text-center text-sh-text-2">Nothing added yet. The formulary on the left shows which categories this consultation mode permits.</p>
          ) : (
            <>
              <ul aria-label="Tele-prescription" className="divide-y divide-sh-line">
                {basket.map((d) => {
                  const entry = TELE_FORMULARY.find((f) => f.drug === d)!
                  const reason = blockedReason(d, mode)
                  return (
                    <li key={d} className="px-[18px] py-[12px]">
                      <div className="flex flex-wrap items-center justify-between gap-[8px]">
                        <span className="flex flex-wrap items-center gap-[8px] font-medium">
                          {d}
                          <PillTag tone={CATEGORY_TONE[entry.category]} size="sm">
                            List {entry.category}
                          </PillTag>
                        </span>
                        <Pill variant="ghost" size="lg" icon={Trash2} onClick={() => setBasket((b) => b.filter((x) => x !== d))} aria-label={`Remove ${d}`}>
                          Remove
                        </Pill>
                      </div>
                      {/* The reason already appears once on the formulary row; the basket just says it cannot be signed. */}
                      {reason && (
                        <p className="mt-[8px] text-[13px] font-medium text-sh-crit-fg">
                          <Icon icon={Ban} size={12} className="mr-[4px] inline" />
                          Blocked — cannot be signed
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="border-t border-sh-line px-[18px] py-[12px] text-[12px] text-sh-text-3">
                Signing prints bilingually with your HPR number and publishes a Prescription record to ABDM. No PHI goes out in any SMS — only a pointer back in.
              </p>
            </>
          )}
        </Card>
      </div>

      <Why label="Why the formulary changes with the mode">
        <p>
          Switching between video and telephone changes what is prescribable, because the guidelines tie the category to the consultation mode — try the toggle in the bar below
          and watch the formulary change.
        </p>
        <p className="text-sh-text-3">
          Signing publishes a Prescription record to ABDM; no PHI goes out in any SMS, only a pointer back in.
          {enc && ` ${enc.type === 'IP' ? 'IP number' : 'OP number'} ${enc.encounterNo} · ${formatDateTime(enc.startedAt)} · `}
          The same note and prescription surfaces as a face-to-face consultation, with one extra gate that the law puts there.
        </p>
      </Why>
    </ScreenFrame>
  )
}
