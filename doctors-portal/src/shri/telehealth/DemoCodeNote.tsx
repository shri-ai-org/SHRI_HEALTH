/**
 * The demonstration code, where the doctor sees it (Video visits, and before a
 * call): the patient demo page asks for it, so patient and doctor meet in this
 * load's rooms. New on every reload (demoCode.ts).
 */

import { KeyRound } from 'lucide-react'

import { cn } from '../lib/cn'
import { Icon } from '../ui/primitives'

import { demoCode } from './demoCode'

export function DemoCodeNote({ className }: { className?: string }) {
  const code = demoCode()
  return (
    <div className={cn('flex flex-wrap items-center gap-[12px] rounded-[18px] bg-sh-card px-[16px] py-[12px]', className)} data-demo-code={code}>
      <Icon icon={KeyRound} size={18} className="text-sh-text-2" />
      <p className="min-w-[220px] flex-1 text-[14px] text-sh-text-2">
        Patient demo code: <b className="text-[18px] tracking-[0.2em] text-sh-text tabular-nums">{code}</b>. Type it on the patient demo page to connect as the patient. It
        changes when this page is reloaded.
      </p>
    </div>
  )
}
