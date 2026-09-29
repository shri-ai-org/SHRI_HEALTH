/**
 * §5.1 — the salutation follows the clock, the name follows the session (the
 * old greeting's rule: "Dr. Iyer" for "Dr. Ananya Iyer"), then the day ·
 * speciality · facility line.
 */

import { FACILITIES } from '@/data/kit'
import { useCurrentStaff, useSession } from '@/store/session'

import { NOW, fmtLongDate, greetingWord } from '../lib/clock'

export function Greeting() {
  const me = useCurrentStaff()
  const facilityCode = useSession((s) => s.facilityCode)
  const facility = FACILITIES.find((f) => f.code === facilityCode) ?? FACILITIES[0]
  const short = /^Dr\.?\s/.test(me.name) ? `Dr. ${me.name.split(' ').slice(-1)[0]}` : me.name
  return (
    <div>
      <h1 className="text-[32px]/[1.15] font-normal tracking-[-0.025em] text-sh-text">
        {greetingWord(NOW)}, {short}
      </h1>
      <p className="mt-[6px] text-[14px]/[1.4] text-sh-text-2">
        {fmtLongDate(NOW)} · {me.speciality ?? me.personaLabel} · {facility.name}
      </p>
    </div>
  )
}
