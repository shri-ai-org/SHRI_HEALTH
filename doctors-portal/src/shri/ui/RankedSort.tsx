/**
 * A ranked list's sort, the old build's `RankedSortControl`
 * (`src/components/ai.tsx:954-996`) in this build's look: the AI order or the
 * deterministic one, always one choice apart, and the capability that ranks
 * it named beside it. With the AI off there is no AI order to offer — the
 * list is in the deterministic one, and says so.
 */

import { ChevronDown, ListFilter } from 'lucide-react'
import { useState } from 'react'

import { Menu, MenuRow } from '../app/menus/Menu'
import { useAiActive } from '../state/ai'

import { Diamond, Icon, PillTag } from './primitives'

/** "Sorted by …" reads as one phrase: its label's first word lower-cased — unless it is an acronym ("AI acuity"). */
function phrase(label: string): string {
  return /^[A-Z]{2}/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`
}

export function RankedSort({
  aiSort,
  onChange,
  aiLabel,
  deterministicLabel,
  capabilityId,
  label,
}: {
  aiSort: boolean
  onChange: (aiSort: boolean) => void
  aiLabel: string
  deterministicLabel: string
  capabilityId: string
  /** What is being sorted — the menu's accessible name. */
  label: string
}) {
  const aiActive = useAiActive()
  const [open, setOpen] = useState(false)
  const byAi = aiActive && aiSort

  if (!aiActive) {
    return (
      <span className="inline-flex flex-wrap items-center gap-[8px] text-[12px] font-medium text-sh-text-2">
        Sorted by {phrase(deterministicLabel)} · AI ranking is off
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-[8px]">
      <span className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-[32px] items-center gap-[6px] rounded-full px-[10px] text-[12px] font-medium text-sh-text-2 transition-colors duration-150 hover:bg-sh-hover hover:text-sh-text"
        >
          Sorted by {phrase(byAi ? aiLabel : deterministicLabel)}
          <Icon icon={ChevronDown} size={13} className="text-sh-chev" />
        </button>
        <Menu open={open} onClose={() => setOpen(false)} width={220} label={label}>
          <MenuRow
            current={byAi}
            onClick={() => {
              onChange(true)
              setOpen(false)
            }}
          >
            <Diamond />
            <span className="text-[13px] font-medium">{aiLabel}</span>
          </MenuRow>
          <MenuRow
            current={!byAi}
            onClick={() => {
              onChange(false)
              setOpen(false)
            }}
          >
            <span className="text-[13px] font-medium">{deterministicLabel}</span>
          </MenuRow>
        </Menu>
      </span>
      {byAi ? (
        <PillTag tone="pend" size="xs" title={`${capabilityId} — the deterministic sort is always one click away`} className="font-semibold">
          <Diamond />
          {capabilityId}
        </PillTag>
      ) : (
        <PillTag tone="neu" size="xs" icon={ListFilter} className="font-semibold">
          Deterministic
        </PillTag>
      )}
    </span>
  )
}
