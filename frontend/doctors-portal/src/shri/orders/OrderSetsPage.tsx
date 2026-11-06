/**
 * S-09-02 · Order sets — `/orders/sets` (`src/screens/m09/S0902.tsx`):
 * "Order sets and pathways, applied rather than remembered."
 *
 * AI-303 monitors adherence at G1 — it notices, you may ignore it, and the
 * printed protocol remains the fallback. It reports where care diverged from
 * the pathway; it does not enforce the pathway. The surface opens on the set
 * due for review; the catalogue is one tap away, and a set's items show only
 * when opened.
 *
 * "A set is applied to an encounter, not to a patient" — the old screen said
 * so, and every set it listed opened R. Lakshmanan's basket and applied
 * nothing. Here Apply asks which encounter, and the set arrives applied in
 * that encounter's basket (S-09-01). The library is S-06-10's, sets made or
 * promoted there included.
 */

import { Check, Layers, Settings, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ENCOUNTERS } from '@/data/clinical'
import { NOW } from '@/data/format'
import { patient } from '@/data/kit'
import { useClinical } from '@/store/clinical'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { encounterLabel } from '../logic/encounter'
import { PATHWAY_ADHERENCE, isoDay, libraryOn, reviewDate, reviewLabel, type LibrarySet } from '../logic/ordersets'
import { useScope } from '../logic/scope'
import { useAiActive } from '../state/ai'
import { Dialog } from '../ui/Dialog'
import { Disclosure, Why } from '../ui/Disclosure'
import { Card, CountBubble, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'

type Scope = 'due' | 'all'
const SCOPES: readonly Scope[] = ['due', 'all']
const DAY_MS = 86_400_000

export function OrderSetsPage() {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const createdSets = useClinical((s) => s.createdSets)
  const promotedSets = useClinical((s) => s.promotedSets)
  const [scope, setScope] = useScope(SCOPES, 'due')
  const [applying, setApplying] = useState<LibrarySet | null>(null)

  const library = libraryOn(isoDay(NOW), createdSets, promotedSets)
  const daysUntil = (s: LibrarySet) => {
    const d = reviewDate(s.reviewDue)
    return d ? Math.round((d.getTime() - NOW.getTime()) / DAY_MS) : null
  }
  /** Due for review: the soonest review date, plus anything else inside 90 days. */
  const dated = library.filter((s) => daysUntil(s) !== null).sort((a, b) => daysUntil(a)! - daysUntil(b)!)
  const due = dated.filter((s, i) => i === 0 || daysUntil(s)! <= 90)
  const rows = scope === 'due' ? due : library
  const used = library.reduce((n, s) => n + s.usedThisMonth, 0)
  // The encounters this clinician can order on — where a set can be applied.
  const encounters = ENCOUNTERS.filter((e) => may(`/encounter/${e.id}/orders/new`))

  return (
    <>
      <ScreenFrame
        screenId="S-09-02"
        heading="Order sets"
        sub={`${due.length} due for review · ${library.length} sets · used ${used} times this month`}
        actions={
          may('/clinician/templates') && (
            <Pill variant="card" size="xl" icon={Settings} iconSize={17} onClick={() => navigate('/clinician/templates')}>
              Manage sets
            </Pill>
          )
        }
      >
        <div className="flex max-w-[896px] flex-col gap-[16px]">
          <Card
            titleSize="sm"
            title={
              <span className="inline-flex items-center gap-[10px]">
                Sets and pathways
                <CountBubble className="bg-sh-control">{rows.length}</CountBubble>
              </span>
            }
            right={
              <Segmented
                label="Which sets to show"
                value={scope}
                onChange={setScope}
                options={[
                  { key: 'due', label: 'Due for review', count: due.length },
                  { key: 'all', label: 'All', count: library.length },
                ]}
              />
            }
            headerClassName="flex-wrap"
          >
            {rows.length === 0 ? (
              <p className="px-[4px] py-[16px] text-center text-[14px] text-sh-text-2">No set is due for review. The whole catalogue is one tap away.</p>
            ) : (
              <ul aria-label="Order sets and pathways" className="flex flex-col">
                {rows.map((s, i) => {
                  const days = daysUntil(s)
                  const soon = days !== null && days <= 90
                  return (
                    <li key={s.id} className={cn('py-[8px]', i > 0 && 'border-t border-sh-line')}>
                      <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] px-[4px]">
                        <span className="min-w-0 flex-1 basis-[260px]">
                          <span className="block truncate text-[15px] font-semibold text-sh-text">{s.name}</span>
                          <span className="mt-[2px] block text-[12px] tabular-nums text-sh-text-3">
                            {s.items.length} items · {s.scope} · {s.owner} · used {s.usedThisMonth} times this month
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-wrap items-center gap-[8px]">
                          {days !== null ? (
                            <PillTag tone={soon ? 'warn' : 'neu'} size="sm" icon={soon ? TriangleAlert : Check} className="tabular-nums">
                              {soon ? `review due ${reviewLabel(s.reviewDue)}` : `reviewed to ${reviewLabel(s.reviewDue)}`}
                            </PillTag>
                          ) : (
                            <PillTag tone="neu" size="sm" icon={Check}>
                              personal · no review
                            </PillTag>
                          )}
                          <Pill variant="primary" size="md" icon={Layers} aria-label={`Apply ${s.name} to an encounter`} onClick={() => setApplying(s)}>
                            Apply
                          </Pill>
                        </span>
                      </div>
                      {/* 8px under the row, so Apply above keeps its 44px target. */}
                      <Disclosure label="items" count={s.items.length} className="mt-[8px]">
                        <div className="flex flex-wrap gap-[6px] px-[10px] pb-[6px]">
                          {s.items.map((item) => (
                            <PillTag key={item} tone="neu" size="sm">
                              {item}
                            </PillTag>
                          ))}
                        </div>
                      </Disclosure>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          {aiActive && (
            <Disclosure label="pathway adherence" count={PATHWAY_ADHERENCE.length}>
              <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-2">
                {PATHWAY_ADHERENCE.map((pw) => (
                  <Card
                    key={pw.pathway}
                    titleSize="sm"
                    title={pw.pathway}
                    right={
                      <PillTag tone={pw.adherence >= 0.85 ? 'norm' : 'warn'} size="sm" icon={pw.adherence >= 0.85 ? Check : TriangleAlert}>
                        {Math.round(pw.adherence * 100)}% overall
                      </PillTag>
                    }
                    headerClassName="flex-wrap"
                  >
                    <p className="-mt-[8px] mb-[12px] text-[12px] tabular-nums text-sh-text-3">{pw.cases} cases this month</p>
                    <ul className="flex flex-col gap-[12px]">
                      {pw.divergences.map((d) => (
                        <li key={d.step}>
                          <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
                            <span className="text-[14px] text-sh-text">{d.step}</span>
                            <span className="text-[13px] font-semibold tabular-nums text-sh-text">{Math.round(d.rate * 100)}%</span>
                          </div>
                          <div className="mt-[6px] h-[8px] overflow-hidden rounded-full bg-sh-inner" aria-hidden="true">
                            <div className={cn('h-full rounded-full', d.rate >= 0.85 ? 'bg-sh-norm' : 'bg-sh-warn')} style={{ width: `${d.rate * 100}%` }} />
                          </div>
                          {d.note && <p className="mt-[4px] text-[12px] text-sh-text-3">{d.note}</p>}
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </div>
            </Disclosure>
          )}

          <Why label="Why a set is applied, not remembered — and what adherence means">
            <p>
              A set is applied to an encounter, not to a patient. Applying it places its orders against the encounter you are in; it does not create a standing instruction,
              and changing the set later does not change orders already placed.
            </p>
            <p>
              A pathway is a default, not a rule. Divergence is often the right call — a patient who cannot produce sputum cannot have a sputum culture. What the monitoring
              gives you is the pattern, so a systematic constraint can be told apart from a habit. Percentages are of cases where the step was clinically applicable, so an
              inapplicable step does not count as a miss.
            </p>
            <p className="text-sh-text-3">AI-303 · G1, and the printed protocol remains the fallback.</p>
          </Why>
        </div>
      </ScreenFrame>

      <Dialog open={applying !== null} onClose={() => setApplying(null)} icon={Layers} title={`Apply ${applying?.name ?? ''}`} subtitle="A set is applied to an encounter, not to a patient.">
        <p className="mb-[10px] text-[14px] text-sh-text-2">Which encounter? Its orders go into that encounter&rsquo;s basket, to be checked and placed there.</p>
        <ul className="flex flex-col gap-[4px]">
          {encounters.map((e) => {
            const p = patient(e.patientId)
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => applying && navigate(`/encounter/${e.id}/orders/new?set=${encodeURIComponent(applying.id)}`)}
                  className="flex min-h-[52px] w-full items-center justify-between gap-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[8px] text-left transition-colors duration-150 hover:bg-sh-hover-strong"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium text-sh-text">{p.name}</span>
                    <span className="block text-[12px] tabular-nums text-sh-text-3">
                      {encounterLabel(e)}
                      {p.bed ? ` · ${p.bed}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </Dialog>
    </>
  )
}
