/**
 * §5.1 — the salutation follows the clock, the name follows the session (the
 * old greeting's rule: "Dr." and the surname alone), then the day ·
 * speciality · facility line.
 */

import { useEffect, useState } from 'react'

import { FACILITIES } from '@/data/kit'
import { useCurrentStaff, useSession } from '@/store/session'

import { clinicNow } from '../../../shri-health/format'
import { userFacility } from '../../../shri-health/opd'
import { NOW, fmtLongDate, greetingWord } from '../lib/clock'

const REAL_API = typeof __SHRI_REAL_API__ !== 'undefined' && __SHRI_REAL_API__

/** "Thu, Nov 5, 2026": the clinic's day in U.S. form (D40). */
const usLongDate = (d: Date) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(d)

export function Greeting() {
  const me = useCurrentStaff()
  const facilityCode = useSession((s) => s.facilityCode)
  const sampleFacility = FACILITIES.find((f) => f.code === facilityCode) ?? FACILITIES[0]
  // With the API: the clinic's clock, the session user's role (the contract has no specialty) and
  // the user's own facility; the sample persona's hospital and fixed date stay with the mock.
  const [facilityName, setFacilityName] = useState<string | undefined>()
  useEffect(() => {
    if (!REAL_API) return
    let current = true
    userFacility()
      .then((f) => {
        if (current) setFacilityName(f?.name)
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [])
  const now = REAL_API ? clinicNow() : NOW
  const short = /^Dr\.?\s/.test(me.name) ? `Dr. ${me.name.split(' ').slice(-1)[0]}` : me.name
  const line = REAL_API
    ? [usLongDate(now), me.personaLabel, facilityName].filter(Boolean).join(' · ')
    : `${fmtLongDate(NOW)} · ${me.speciality ?? me.personaLabel} · ${sampleFacility.name}`
  return (
    <div>
      <h1 className="text-[32px]/[1.15] font-normal tracking-[-0.025em] text-sh-text">
        {greetingWord(now)}, {short}
      </h1>
      <p className="mt-[6px] text-[14px]/[1.4] text-sh-text-2">{line}</p>
    </div>
  )
}
