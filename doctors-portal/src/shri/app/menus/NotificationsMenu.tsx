import { Brain, CalendarX, ChevronRight, ClipboardX, DoorOpen, FileText, FlaskConical, Send, Signature, CalendarClock, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import type { Tone } from '../../mocks/types'
import { SEVERITY_GROUP, type Notice, type NoticeKind, type Severity } from '../../state/notifications'
import { useShri } from '../../state/store'
import { Icon, ToneDot } from '../../ui/primitives'
import { canonical } from '../paths'

import { useNotices } from './useNotices'
import { Menu, MenuRow } from './Menu'

const KIND_ICON: Record<NoticeKind, LucideIcon> = {
  result: FlaskConical,
  stroke: Brain,
  cosign: Signature,
  schedule: CalendarX,
  appointment: CalendarClock,
  discharge: DoorOpen,
  instructions: FileText,
  order: ClipboardX,
}

const SEVERITY_TONE: Record<Severity, Tone> = { critical: 'crit', urgent: 'warn', routine: 'pend' }
const RECIPIENT: Record<NonNullable<Notice['recipient']>, string> = {
  patient: 'the patient',
  'front office': 'the front office',
  author: 'the author',
  colleague: 'a colleague',
  department: 'the performing department',
}
const ORDER: Severity[] = ['critical', 'urgent', 'routine']

/**
 * §6.6 — the bell, on the one notifications store: grouped Critical / Urgent /
 * Routine in the old bell's words, each item opening its source screen. What
 * this build sent on the doctor's behalf follows under Sent. Items whose
 * screen the persona cannot open are absent, as the nav's modules are.
 */
export function NotificationsMenu() {
  const open = useShri((s) => s.menu === 'notifications')
  const setMenu = useShri((s) => s.setMenu)
  const navigate = useNavigate()
  const { inbox, sent } = useNotices()

  function go(n: Notice) {
    setMenu(null)
    navigate(canonical(n.to))
  }

  const groups = ORDER.map((sev) => ({ sev, items: inbox.filter((n) => n.severity === sev) })).filter((g) => g.items.length > 0)

  return (
    <Menu open={open} onClose={() => setMenu(null)} width={360} label="Notifications">
      {groups.length === 0 && sent.length === 0 && <p className="px-[10px] py-[12px] text-[14px] text-sh-text-2">Nothing is waiting on you.</p>}
      {groups.map((g, gi) => (
        <div key={g.sev} className={gi > 0 ? 'mt-[4px] border-t border-sh-line pt-[6px]' : undefined}>
          <div className="flex items-center gap-[8px] px-[10px] pb-[4px] pt-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
            <ToneDot tone={SEVERITY_TONE[g.sev]} />
            {SEVERITY_GROUP[g.sev]}
          </div>
          {g.items.map((n) => (
            <NoticeRow key={n.id} n={n} onOpen={() => go(n)} />
          ))}
        </div>
      ))}
      {sent.length > 0 && (
        <div className="mt-[4px] border-t border-sh-line pt-[6px]">
          <div className="flex items-center gap-[8px] px-[10px] pb-[4px] pt-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
            <Icon icon={Send} size={12} />
            Sent
          </div>
          {sent.slice(0, 6).map((n) => (
            <NoticeRow key={n.id} n={n} onOpen={() => go(n)} />
          ))}
        </div>
      )}
      <p className="mt-[4px] border-t border-sh-line px-[10px] pb-[4px] pt-[10px] text-[12px]/[1.4] text-sh-text-3">
        An out-of-app message never carries the reason, the diagnosis or a result — only a pointer back in.
      </p>
    </Menu>
  )
}

function NoticeRow({ n, onOpen }: { n: Notice; onOpen: () => void }) {
  const tone = SEVERITY_TONE[n.severity]
  return (
    <MenuRow onClick={onOpen} aria-label={`${SEVERITY_GROUP[n.severity]}: ${n.title}, ${n.detail}`}>
      <span className={`sh-tone-${tone} inline-flex size-[32px] shrink-0 items-center justify-center rounded-full bg-(--t-bg) text-(--t-fg)`} aria-hidden="true">
        <Icon icon={KIND_ICON[n.kind]} size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{n.title}</span>
        <span className="block truncate text-[12px] text-sh-text-3">
          {n.recipient ? `To ${RECIPIENT[n.recipient]} · ` : ''}
          {n.detail}
        </span>
      </span>
      <Icon icon={ChevronRight} size={16} className="text-sh-chev" />
    </MenuRow>
  )
}
