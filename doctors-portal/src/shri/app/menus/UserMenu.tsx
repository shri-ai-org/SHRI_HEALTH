import { Check, Moon, Sun } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { PERSONA_LIST, PERSONA_SPECS, type PersonaId } from '@/atlas/personas'
import { STAFF_FOR_PERSONA, staff } from '@/data/kit'
import { useAI } from '@/store/ai'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { useShri } from '../../state/store'
import { Icon, Toggle } from '../../ui/primitives'
import { landingFor } from '../landing'

import { Menu, MenuHeader, MenuRow } from './Menu'

/**
 * §6.7 — who is working, "Sign in as" over the old build's seven personas and
 * the ◆ AI fabric switch. There is no sign-out: the portal has no sign-in. Switching persona is the old
 * behaviour: the rail and the actions change, the persona lands where the
 * atlas says, and a toast names both. Under 360px the app bar has no room for
 * the theme toggle, so it lives here.
 */
export function UserMenu() {
  const open = useShri((s) => s.menu === 'user')
  const setMenu = useShri((s) => s.setMenu)
  const setAiOn = useShri((s) => s.setAiOn)
  const theme = useShri((s) => s.theme)
  const toggleTheme = useShri((s) => s.toggleTheme)
  const aiOn = useAI((s) => s.aiEnabled)
  const persona = useSession((s) => s.persona)
  const setPersona = useSession((s) => s.setPersona)
  const toast = useUI((s) => s.toast)
  const me = useCurrentStaff()
  const navigate = useNavigate()
  const note = PERSONA_SPECS[persona].note

  function switchPersona(p: PersonaId) {
    setPersona(p)
    setMenu(null)
    const spec = PERSONA_SPECS[p]
    const landing = landingFor(p)
    navigate(landing)
    toast({
      tone: 'info',
      title: `Signed in as ${spec.name}`,
      detail: spec.note ?? `Landing on ${landing}. The nav rail now shows only what they may enter.`,
    })
  }

  return (
    <Menu open={open} onClose={() => setMenu(null)} width={330} label="Account">
      <div className="px-[10px] pb-[8px] pt-[6px]">
        <div className="text-[15px] font-semibold text-sh-text">{me.name}</div>
        <div className="text-[12px] text-sh-text-3">{me.personaLabel}</div>
        <div className="mt-[2px] text-[12px] tabular-nums text-sh-text-3">
          {me.identifierKind} {me.identifier}
        </div>
        {note && <p className="mt-[8px] rounded-[10px] bg-sh-warn-bg px-[8px] py-[4px] text-[12px] font-medium text-sh-warn-fg">{note}</p>}
      </div>
      <div className="border-t border-sh-line pt-[6px]">
        <MenuHeader>Sign in as — the rail and the actions change</MenuHeader>
        {PERSONA_LIST.map((p) => (
          <MenuRow key={p.id} current={p.id === persona} onClick={() => switchPersona(p.id)} className="py-[7px]">
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium">{p.name}</span>
              <span className="block truncate text-[12px] text-sh-text-3">
                {p.id} · {staff(STAFF_FOR_PERSONA[p.id]).name}
              </span>
            </span>
            {p.id === persona && <Icon icon={Check} size={16} strokeWidth={2.2} />}
          </MenuRow>
        ))}
      </div>
      <div className="mt-[4px] border-t border-sh-line pt-[8px]">
        <div className="flex items-center gap-[12px] px-[10px] py-[6px]">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-sh-text">
              <span className="mr-[6px] text-[10px] text-sh-ai" aria-hidden="true">
                ◆
              </span>
              AI fabric
            </span>
            <span className="block text-[12px] text-sh-text-3">Off hides every ◆ and unmounts the assistant bubble. Deterministic safety checks keep running.</span>
          </span>
          <Toggle checked={aiOn} onChange={setAiOn} label="AI fabric enabled" />
        </div>
      </div>
      <div className="mt-[4px] hidden border-t border-sh-line pt-[6px] max-[360px]:block">
        <MenuRow onClick={toggleTheme}>
          <Icon icon={theme === 'light' ? Moon : Sun} size={16} />
          <span className="text-[14px] font-medium">{theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}</span>
        </MenuRow>
      </div>
    </Menu>
  )
}
