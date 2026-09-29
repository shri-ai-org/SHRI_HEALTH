/**
 * S-06-10 · Templates and order sets — `/clinician/templates`
 * (`src/screens/m06/S0610.tsx`): "Order sets and templates — personal, then
 * governed."
 *
 * W-06-4's step 3 is the point of the screen: "facility-wide promotion is a
 * GOVERNANCE ACT with a named owner and a review date." A personal set that is
 * wrong affects your patients; a facility-wide one affects everyone's, so
 * someone has to be accountable for it by name. The default slice is what is
 * due for review; a row's items show once it is opened.
 *
 * Where the old screen fell short, this one keeps its word: a set made here is
 * kept, carries its maker's name and no review date until it is governed, and
 * can itself be promoted; promotion needs a review date after today, and is
 * dated and on the audit trail as the governance act it says it is; and
 * "Effective on" shows the library as it stood that day.
 */

import { ArrowUp, CalendarDays, Check, ChevronDown, ChevronRight, Clock, Info, Plus, X } from 'lucide-react'
import { useId, useState } from 'react'

import { NOW, formatDate, formatTime } from '@/data/format'
import { STAFF } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { isDue, isoDay, libraryOn, reviewAhead, reviewLabel, type LibrarySet } from '../logic/ordersets'
import { useScope } from '../logic/scope'
import { useAiActive } from '../state/ai'
import { SuggestionCard } from '../ui/ai'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Dialog } from '../ui/Dialog'
import { Why } from '../ui/Disclosure'
import { Field, Select, TextArea, TextInput } from '../ui/forms'
import { Card, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'

type Scope = 'due' | 'all'

const TODAY = isoDay(NOW)

/** One item per line, or comma-separated — the old field's rule. */
function splitItems(text: string): string[] {
  return text
    .split(/\n|,/)
    .map((i) => i.trim())
    .filter(Boolean)
}

export function TemplatesPage() {
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const createdSets = useClinical((s) => s.createdSets)
  const promotedSets = useClinical((s) => s.promotedSets)
  const promoteSet = useClinical((s) => s.promoteSet)
  const createSet = useClinical((s) => s.createSet)

  const [effectiveOn, setEffectiveOn] = useState(TODAY)
  const [search, setSearch] = useState('')
  const [scope, setScope] = useScope<Scope>(['due', 'all'], 'due')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [promoting, setPromoting] = useState<string | null>(null)
  const [owner, setOwner] = useState('Dr. Vivek Sharma')
  const [reviewDue, setReviewDue] = useState('2027-03-31')
  const [creating, setCreating] = useState(false)
  const [newSet, setNewSet] = useState({ name: '', items: '' })
  const ids = useId()

  /** A past day is history: it is read, never changed — changes are made to today's library. */
  const past = effectiveOn < TODAY
  const library = libraryOn(effectiveOn || TODAY, createdSets, promotedSets)
  const q = search.trim().toLowerCase()
  const allSets = library.filter((s) => !q || s.name.toLowerCase().includes(q))
  const due = allSets.filter((s) => isDue(s.reviewDue))
  const sets = scope === 'due' ? due : allSets
  // Found among every set, the ones made here included (the old dialog found only the fixtures).
  const target = library.find((s) => s.id === promoting)
  const reviewOk = reviewAhead(reviewDue)
  const items = splitItems(newSet.items)
  const newOk = newSet.name.trim().length >= 3 && items.length > 0

  function promote() {
    if (!target || !reviewOk || past) return
    promoteSet(target.id, owner, reviewDue, NOW.toISOString())
    audit({
      event: 'ORDERSET.PROMOTED',
      actor: me.name,
      actorId: me.id,
      detail: `${target.name} · ${target.id} · owner ${owner} · review due ${reviewLabel(reviewDue)}`,
    })
    toast({ tone: 'success', title: 'Promoted to facility-wide', detail: `Owner ${owner} · review due ${reviewLabel(reviewDue)}. Recorded as a governance act.` })
    setPromoting(null)
  }

  function create() {
    if (!newOk || past) return
    const made = createSet({
      name: newSet.name.trim(),
      scope: 'Personal',
      owner: me.name,
      // A personal set is its maker's to change: it has no review date until it is governed.
      reviewDue: '—',
      items,
      usedThisMonth: 0,
      createdAt: NOW.toISOString(),
      createdBy: me.name,
    })
    audit({ event: 'ORDERSET.CREATED', actor: me.name, actorId: me.id, detail: `${made.name} · ${made.id} · ${items.length} ${items.length === 1 ? 'item' : 'items'} · personal scope` })
    toast({ tone: 'success', title: 'Order set created', detail: `${made.name} · ${items.length} ${items.length === 1 ? 'item' : 'items'} · personal scope.` })
    setCreating(false)
    setNewSet({ name: '', items: '' })
  }

  const pastTitle = past ? 'Changes are made to today’s library, not to a past one' : undefined

  return (
    <>
      <ScreenFrame
        screenId="S-06-10"
        heading="Templates and order sets"
        sub={`${allSets.length} sets · ${due.length} due for review`}
        actions={
          <>
            <label className="flex items-center gap-[8px] text-[13px] text-sh-text-2">
              <Icon icon={CalendarDays} size={15} className="text-sh-text-3" />
              Effective on
              {/* The field itself is the 46px target; the words beside it name it. */}
              <input
                type="date"
                value={effectiveOn}
                onChange={(e) => setEffectiveOn(e.target.value || TODAY)}
                aria-label="Effective on"
                className="h-[46px] rounded-full bg-sh-card px-[16px] text-[13px] tabular-nums text-sh-text"
              />
            </label>
            <Pill
              variant="primary"
              size="xl"
              icon={Plus}
              iconSize={17}
              aria-disabled={past}
              title={pastTitle}
              className={cn(past && 'opacity-40')}
              onClick={() => !past && setCreating(true)}
            >
              New set
            </Pill>
          </>
        }
        rail={
          <SuggestionCard
            touchpointId="templates:suggest"
            capabilityId="AI-302"
            title="Add a sputum culture to your CAP set"
            evidence="You have added a sputum culture manually to 11 of your last 14 pneumonia admissions. The facility set does not include it."
            band="MED"
            score={0.78}
            gate="G2"
            explain={{
              touchpointId: 'templates:suggest',
              capabilityId: 'AI-302',
              claim: 'Your local practice diverges from the facility order set on one item.',
              confidence: 0.78,
              band: 'MED',
              computedAt: formatTime(NOW),
              inputs: [
                { label: 'Your last 14 pneumonia admissions', source: 'Order history, 90 days' },
                { label: 'OS.CAP-ADULT contents', source: 'Order set library' },
              ],
              evidence: ['Sputum culture added manually in 11 of 14 cases.', 'Adding it to the set would remove 11 manual steps a quarter.'],
              model: 'orderset-rec v2.0.3',
              limits: [
                'Learns from your ordering, so it will reproduce your habits including the unhelpful ones.',
                'A browsable library is the fallback and is never hidden.',
                'It cannot tell whether a divergence is an improvement or a deviation.',
              ],
            }}
          />
        }
        railTitle="Governance"
        railBadge={aiActive ? 1 : undefined}
      >
        <div className="flex max-w-[896px] flex-col gap-[16px]">
          {past && (
            <p role="status" className="flex items-start gap-[8px] rounded-[14px] bg-sh-inner px-[14px] py-[10px] text-[13px] text-sh-text-2">
              <Icon icon={Info} size={14} className="mt-[2px] shrink-0" />
              The library as it stood on {formatDate(new Date(`${effectiveOn}T00:00:00`))}. Each version is effective from a date, so a set made or promoted since then is shown
              as it was.
            </p>
          )}

          {/* On the page surface, so the field takes the card's fill to read as a field. */}
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order sets and templates…"
            aria-label="Search order sets and templates"
            className="bg-sh-card hover:bg-sh-card"
          />

          <Segmented
            label="Which sets to show"
            value={scope}
            onChange={setScope}
            options={[
              { key: 'due', label: 'Due for review', count: due.length },
              { key: 'all', label: 'All', count: allSets.length },
            ]}
          />

          <Card
            titleSize="sm"
            title={
              <span className="inline-flex items-center gap-[10px]">
                Order sets and templates
                <CountBubble className="bg-sh-control">{sets.length}</CountBubble>
              </span>
            }
          >
            {sets.length === 0 ? (
              <p className="px-[4px] py-[8px] text-[14px] text-sh-text-2">
                {scope === 'due' && !q
                  ? 'Nothing is due for review. A set’s review date passing, or one arriving without one, would put it here.'
                  : `No set matches “${search.trim()}”${scope === 'due' ? ' among those due for review' : ''}.`}
              </p>
            ) : (
              <ul className="flex flex-col">
                {sets.map((s, i) => (
                  <SetRow
                    key={s.id}
                    set={s}
                    first={i === 0}
                    open={expanded === s.id}
                    onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                    onPromote={() => setPromoting(s.id)}
                    promoteBlocked={pastTitle}
                  />
                ))}
              </ul>
            )}
          </Card>

          <Why label="Effective dates and governance">
            <p>Changing a set does not rewrite history. Each version is effective from a date, and an order placed last month still shows the set as it was then.</p>
            <p>
              A personal set is yours to change freely. A facility-wide one needs a named owner and a review date, because it changes what everyone else orders — which is why
              promotion asks for both.
            </p>
          </Why>
        </div>
      </ScreenFrame>

      <ConfirmDialog
        open={promoting !== null && target !== undefined}
        title="Promote to facility-wide?"
        consequence={`"${target?.name ?? ''}" would become available to every clinician at this facility. That is a governance act: it acquires a named owner who is accountable for its contents, and a review date after which it must be re-approved.`}
        confirmLabel="Promote with an owner"
        confirmDisabled={!reviewOk}
        onConfirm={promote}
        onCancel={() => setPromoting(null)}
      >
        <div className="flex flex-col gap-[12px]">
          <Field label="Accountable owner" required htmlFor={`${ids}-owner`}>
            <Select id={`${ids}-owner`} value={owner} onChange={(e) => setOwner(e.target.value)}>
              {STAFF.filter((s) => s.identifierKind === 'HPR').map((s) => (
                <option key={s.id} value={s.name}>
                  {s.name} · {s.personaLabel}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Review due"
            required
            htmlFor={`${ids}-review`}
            error={reviewOk ? undefined : 'A review date after today — one already past could never be met.'}
          >
            <TextInput id={`${ids}-review`} type="date" value={reviewDue} aria-invalid={!reviewOk} onChange={(e) => setReviewDue(e.target.value)} />
          </Field>
          <p className="flex items-start gap-[8px] text-[12px] text-sh-text-3">
            <Icon icon={Info} size={13} className="mt-[2px] shrink-0" />
            Your own version stays available as a personal set. Promotion copies it; it does not move it.
          </p>
        </div>
      </ConfirmDialog>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New order set"
        subtitle="Personal scope. Promote it to facility-wide from the list once it has an owner and a review date."
        icon={Plus}
        footer={
          <>
            <Pill variant="control" size="lg" icon={X} onClick={() => setCreating(false)}>
              Cancel
            </Pill>
            <Pill variant="primary" size="lg" icon={Check} disabled={!newOk} className="disabled:opacity-40" onClick={create}>
              Create set
            </Pill>
          </>
        }
      >
        <div className="flex flex-col gap-[12px]">
          <Field label="Name" required htmlFor={`${ids}-name`}>
            <TextInput
              id={`${ids}-name`}
              value={newSet.name}
              data-autofocus="true"
              onChange={(e) => setNewSet((d) => ({ ...d, name: e.target.value }))}
              placeholder="Acute asthma — adult"
            />
          </Field>
          <Field label="Items" required htmlFor={`${ids}-items`} hint="One per line, or comma-separated">
            <TextArea
              id={`${ids}-items`}
              rows={5}
              value={newSet.items}
              onChange={(e) => setNewSet((d) => ({ ...d, items: e.target.value }))}
              placeholder={'CBC\nCRP\nChest X-ray PA'}
            />
          </Field>
        </div>
      </Dialog>
    </>
  )
}

/** One set: what it is and whose, when it is due, how often it is used; its items once opened; Promote while it is personal. */
function SetRow({
  set: s,
  first,
  open,
  onToggle,
  onPromote,
  promoteBlocked,
}: {
  set: LibrarySet
  first: boolean
  open: boolean
  onToggle: () => void
  onPromote: () => void
  promoteBlocked?: string
}) {
  const due = isDue(s.reviewDue)
  const itemsId = `${s.id}-items`
  return (
    <li className={cn(!first && 'border-t border-sh-line')}>
      <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[6px] py-[6px]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={itemsId}
          onClick={onToggle}
          className="flex min-h-[56px] min-w-0 flex-1 basis-[280px] flex-wrap items-center gap-x-[12px] gap-y-[6px] rounded-[14px] px-[10px] py-[6px] text-left transition-colors duration-150 hover:bg-sh-hover"
        >
          <span className="min-w-0 flex-1 basis-[200px]">
            <span className="block truncate text-[15px] font-medium text-sh-text">{s.name}</span>
            <span className="block truncate text-[12px] tabular-nums text-sh-text-3">
              {s.items.length} items · {s.scope} · {s.owner}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-[8px]">
            {due && (
              <PillTag tone="warn" size="sm" icon={Clock}>
                review due {reviewLabel(s.reviewDue)}
              </PillTag>
            )}
            <span className="text-[12px] tabular-nums text-sh-text-3">{s.usedThisMonth}/mo</span>
            <Icon icon={open ? ChevronDown : ChevronRight} size={14} className="text-sh-text-3" />
          </span>
        </button>
        {s.scope === 'Personal' && (
          <Pill
            variant="primary"
            size="md"
            icon={ArrowUp}
            aria-label={`Promote ${s.name}`}
            aria-disabled={promoteBlocked !== undefined}
            title={promoteBlocked}
            className={cn('mr-[6px]', promoteBlocked && 'opacity-40')}
            onClick={() => !promoteBlocked && onPromote()}
          >
            Promote
          </Pill>
        )}
      </div>
      {open && (
        <div id={itemsId} className="flex flex-wrap gap-[6px] px-[10px] pb-[12px]">
          {s.items.map((i) => (
            <PillTag key={i} tone="neu" size="sm">
              {i}
            </PillTag>
          ))}
        </div>
      )}
    </li>
  )
}
