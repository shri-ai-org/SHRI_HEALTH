import { Check } from 'lucide-react'

import { FACILITIES } from '@/data/kit'
import { useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { cn } from '../../lib/cn'
import { useShri } from '../../state/store'
import { Icon } from '../../ui/primitives'

import { Menu, MenuHeader, MenuRow } from './Menu'

/**
 * §6.5 — code tile · name · meta · ✓ on current, over the old build's four
 * facilities. Switching changes authorization scope, so it is unmistakable:
 * the old caution toast says so, word for word (GP-07).
 */
export function FacilityMenu() {
  const open = useShri((s) => s.menu === 'facility')
  const setMenu = useShri((s) => s.setMenu)
  const current = useSession((s) => s.facilityCode)
  const setFacility = useSession((s) => s.setFacility)
  const toast = useUI((s) => s.toast)
  return (
    <Menu open={open} onClose={() => setMenu(null)} width={340} align="left" label="Switch facility">
      <MenuHeader>Facility — changes your authorization scope</MenuHeader>
      {FACILITIES.map((f) => {
        const active = f.code === current
        return (
          <MenuRow
            key={f.code}
            current={active}
            onClick={() => {
              setFacility(f.code)
              setMenu(null)
              toast({ tone: 'caution', title: `Scope changed to ${f.code}`, detail: 'What you may read and write has changed with it.' })
            }}
          >
            <span
              className={cn(
                'inline-flex size-[40px] shrink-0 items-center justify-center rounded-[12px] text-[13px] font-semibold',
                active ? 'bg-sh-accent text-sh-accent-ink' : 'bg-sh-accent-soft text-sh-text',
              )}
            >
              {f.code}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{f.name}</span>
              <span className="block truncate text-[12px] text-sh-text-3">
                {f.role} · {f.beds} beds · {f.strokeCapability}
              </span>
            </span>
            {active && <Icon icon={Check} size={16} strokeWidth={2.2} className="text-sh-text" />}
          </MenuRow>
        )
      })}
    </Menu>
  )
}
