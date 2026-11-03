import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useToast } from '../../hooks/useToast'
import { getState } from '../../domain/store'
import { findAbhaHolder } from '../../domain/selectors'
import { registerPatient } from '../../domain/actions'
import { ABHA_REGISTERED_EVENT, ABHA_SCAN_EVENT, parseAbhaScan } from '../../utils/abhaQr'
import type { AbhaScan } from '../../utils/abhaQr'
import { nextNameInput } from '../../utils/validation'
import { takeAbhaScan } from '../../utils/abhaScanGate'
import type { Patient } from '../../types/patient'

// A USB QR scanner (Zebra DS2208 in its default keyboard mode) "types" the
// code in a burst — a few milliseconds per key — usually ending with Enter.
// People type ten times slower. Once three keys in a row arrive that fast, the
// burst is a scan: from then on its keys are held back from the page, so they
// neither land in a field nor trigger shortcuts (the "/" in "1/57" would jump
// to the search box). The first keys, typed before the burst was recognised,
// are cleared from the focused field when the scan ends.
const FAST_MS = 35
const CONFIRM_AFTER = 3
const IDLE_END_MS = 150
const MIN_LENGTH = 8

type Burst = { text: string; leaked: string; lastAt: number; fastRun: number; scanning: boolean }

function emptyBurst(): Burst {
  return { text: '', leaked: '', lastAt: 0, fastRun: 0, scanning: false }
}

/** Remove the first keys of the scan that reached the focused field, the React way. */
function stripLeaked(leaked: string) {
  const el = document.activeElement
  if (!leaked || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  if (!el.value.endsWith(leaked)) return
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, el.value.slice(0, -leaked.length))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** The ABHA card's JSON inside whatever was scanned, else the text itself. */
function payloadOf(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

/**
 * Listens for ABHA cards scanned anywhere in the portal. A card already linked
 * to a patient opens their profile. A new card registers the patient from the
 * card straight away — age from the date of birth — then shows the
 * acknowledgement and their profile. A card missing something registration
 * needs (a mobile number, say) opens Register Patient filled from the card.
 */
export function AbhaScannerListener() {
  const navigate = useNavigate()
  const location = useLocation()
  const { notify } = useToast()
  const where = useRef(location.pathname)
  useEffect(() => {
    where.current = location.pathname
  }, [location.pathname])

  useEffect(() => {
    let burst = emptyBurst()
    let idle: number | undefined
    const onRegisterPage = () => where.current.startsWith('/register/new')

    function handle(scan: AbhaScan) {
      const state = getState()
      const holder = (scan.abhaNumber ? findAbhaHolder(state, scan.abhaNumber) : null) ?? (scan.abhaAddress ? findAbhaHolder(state, scan.abhaAddress) : null)
      if (holder) {
        notify(`Opened ${holder.name}`, { detail: holder.uhid })
        navigate(`/patients/${holder.uhid}`)
        return
      }
      let patient: Patient
      try {
        patient = registerPatient({
          name: nextNameInput(scan.name ?? '').trim(),
          age: scan.age ?? '',
          sex: scan.sex ?? '',
          mobile: scan.mobile ?? '',
          abhaId: scan.abhaAddress ?? scan.abhaNumber,
          address: scan.address?.slice(0, 200),
        })
      } catch (err) {
        // Something registration needs is missing or wrong on the card: the form, filled, with it marked.
        notify('Complete the registration', { tone: 'error', detail: err instanceof Error ? err.message : String(err) })
        if (onRegisterPage()) window.dispatchEvent(new CustomEvent<AbhaScan>(ABHA_SCAN_EVENT, { detail: scan }))
        else navigate('/register/new', { state: { abhaScan: scan } })
        return
      }
      // Registered: the acknowledgement, then the profile (Register Patient shows both).
      if (onRegisterPage()) window.dispatchEvent(new CustomEvent<Patient>(ABHA_REGISTERED_EVENT, { detail: patient }))
      else navigate('/register/new', { state: { registeredId: patient.patientId } })
    }

    function finish(viaEnter: boolean) {
      window.clearTimeout(idle)
      const done = burst
      burst = emptyBurst()
      if (!done.scanning || done.text.length < MIN_LENGTH) return
      stripLeaked(done.leaked)
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      const scan = parseAbhaScan(payloadOf(done.text))
      // With the Scan ABHA card open, it shows the scan and fetching first, then runs the same flow.
      if (scan) {
        if (!takeAbhaScan(() => handle(scan))) handle(scan)
      }
      else if (viaEnter || done.text.includes('{')) notify('Not an ABHA QR code', { tone: 'error', detail: 'Scan the QR code on the patient’s ABHA card.' })
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Shift' || event.key === 'CapsLock') return
      if (event.key === 'Enter') {
        if (burst.scanning) {
          event.preventDefault()
          event.stopPropagation()
          finish(true)
        } else burst = emptyBurst()
        return
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
        if (!burst.scanning) burst = emptyBurst()
        return
      }
      const gap = burst.lastAt ? event.timeStamp - burst.lastAt : Infinity
      if (gap > 300) burst = emptyBurst()
      burst.lastAt = event.timeStamp
      burst.text += event.key
      if (!burst.scanning) {
        burst.fastRun = gap <= FAST_MS ? burst.fastRun + 1 : 0
        if (burst.fastRun >= CONFIRM_AFTER) {
          burst.scanning = true
          // Everything before this key already reached the page.
          burst.leaked = burst.text.slice(0, -1).slice(-(CONFIRM_AFTER + 1))
        } else if (gap > FAST_MS) {
          // A person typing: only this key counts towards a new burst.
          burst.text = event.key
        }
      }
      if (burst.scanning) {
        event.preventDefault()
        event.stopPropagation()
        // Scanners without an Enter suffix: the scan ends when the keys stop.
        window.clearTimeout(idle)
        idle = window.setTimeout(() => finish(false), IDLE_END_MS)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.clearTimeout(idle)
    }
  }, [navigate, notify])

  return null
}
