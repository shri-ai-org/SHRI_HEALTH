import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ElementType } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FileHeart, HeartPulse, Hospital, ScanLine, ShieldCheck, Smartphone, Stethoscope } from 'lucide-react'
import { cn } from '../../utils/cn'
import type { IconTone } from '../../utils/toneHex'
import { SoftIconTile } from '../ui/IconTile'

/** The government's ABHA registration (ABDM), for a patient who has none. */
const ABHA_REGISTER_URL = 'https://abha.abdm.gov.in/abha/v3/register'

/** What ABHA does for a patient — shown to explain why it is worth creating. */
const ABHA_BENEFITS: { text: string; icon: ElementType; hue: IconTone }[] = [
  { text: 'One patient, one complete health history', icon: FileHeart, hue: 'teal' },
  { text: 'Skip repeat MRIs & tests unless needed', icon: ScanLine, hue: 'orange' },
  { text: 'Access all records digitally, anytime', icon: Smartphone, hue: 'blue' },
  { text: 'Move between hospitals seamlessly', icon: Hospital, hue: 'violet' },
  { text: 'You control your data, always', icon: ShieldCheck, hue: 'green' },
  { text: 'Doctors see your full medical journey', icon: Stethoscope, hue: 'pink' },
]

const POPUP_WIDTH = 380
/** Space kept between the popup and the button, and from the window edge. */
const GAP = 12
const EDGE = 16

type Placement = {
  top: number
  left: number
  /** Where the popup sits relative to the button; its arrow points back at it. */
  side: 'right' | 'left' | 'below' | 'above'
  /** Offset of the arrow along the edge that faces the button. */
  arrow: number
  onHeader: boolean
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

/**
 * Where the popup goes. Beside the button it hangs DOWN from the button's top
 * edge, so the fields above (sex, mobile) stay in view; it is lifted only as
 * far as the window's bottom edge forces. Without room beside (a narrow
 * window) it opens below the button, or above it, never over the button.
 */
function placePopup(anchor: DOMRect, popup: { width: number; height: number }, headerHeight: number): Placement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const anchorMid = anchor.top + anchor.height / 2

  const besideLeft =
    anchor.right + GAP + popup.width <= vw - EDGE
      ? { side: 'right' as const, left: anchor.right + GAP }
      : anchor.left - GAP - popup.width >= EDGE
        ? { side: 'left' as const, left: anchor.left - GAP - popup.width }
        : null
  if (besideLeft) {
    const top = clamp(anchor.top - 6, EDGE, vh - EDGE - popup.height)
    const arrow = clamp(anchorMid - top, 20, popup.height - 20)
    return { ...besideLeft, top, arrow, onHeader: arrow < headerHeight }
  }

  const left = clamp(anchor.left + anchor.width / 2 - popup.width / 2, EDGE, vw - EDGE - popup.width)
  const arrow = clamp(anchor.left + anchor.width / 2 - left, 20, popup.width - 20)
  const roomBelow = vh - EDGE - (anchor.bottom + GAP)
  const roomAbove = anchor.top - GAP - EDGE
  if (popup.height <= roomBelow || roomBelow >= roomAbove) {
    return { side: 'below', top: anchor.bottom + GAP, left, arrow, onHeader: true }
  }
  return { side: 'above', top: Math.max(EDGE, anchor.top - GAP - popup.height), left, arrow, onHeader: false }
}

/**
 * "Create ABHA" — opens ABDM's registration in a new tab, so the form here
 * stays as it is. Pointing at it with a mouse (or tabbing to it) shows what
 * ABHA means for the patient, to share with them; it closes as the pointer
 * moves away. A tap on a touch screen just opens ABDM — there is no hover to
 * show the card on, and it would only cover the form the patient is filling.
 */
/** `compact` sizes it like the small buttons beside it; `choice` is the patient
 *  header's chip — "Create new ABHA" — beside "Link existing ABHA". */
export function CreateAbhaLink({ compact = false, choice = false }: { compact?: boolean; choice?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<Placement | null>(null)
  const anchorRef = useRef<HTMLAnchorElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const tipId = useId()

  useLayoutEffect(() => {
    // Measured before paint, so the popup never shows in the wrong place.
    if (!open) return
    const anchor = anchorRef.current?.getBoundingClientRect()
    const el = popupRef.current
    if (!anchor || !el) return
    // offset sizes, not the rect: the pop-in animation starts slightly scaled down.
    setPlace(placePopup(anchor, { width: el.offsetWidth, height: el.offsetHeight }, headerRef.current?.offsetHeight ?? 0))
  }, [open])

  // Scrolling or resizing moves the button away from the popup: close it.
  useLayoutEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <span
      className="inline-flex shrink-0"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setOpen(true)
      }}
      onPointerLeave={() => setOpen(false)}
      onFocus={(event) => {
        // Keyboard focus only: a tap or click focuses the link too.
        if (event.target.matches(':focus-visible')) setOpen(true)
      }}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <a
        ref={anchorRef}
        href={ABHA_REGISTER_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={open ? tipId : undefined}
        className={
          choice
            ? 'focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[color-mix(in_oklab,var(--color-hue-teal)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-hue-teal)_10%,var(--color-surface-1))] px-3 text-xs font-semibold text-[var(--color-hue-teal)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-hue-teal)_18%,var(--color-surface-1))]'
            : cn(
                'focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary-200 dark:border-primary-500/35 bg-primary-50 text-sm font-semibold text-primary-text transition-colors hover:bg-primary-100 hover:border-primary-300',
                compact ? 'min-h-9 px-3' : 'min-h-11 px-3.5',
              )
        }
      >
        {choice ? (
          <>
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Create ABHA
          </>
        ) : (
          <>
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Create ABHA
          </>
        )}
      </a>
      {open
        ? createPortal(
            <div
              ref={popupRef}
              id={tipId}
              role="tooltip"
              style={{
                width: `min(${POPUP_WIDTH}px, calc(100vw - ${EDGE * 2}px))`,
                top: place?.top ?? 0,
                left: place?.left ?? 0,
                visibility: place ? 'visible' : 'hidden',
              }}
              className="pointer-events-none fixed z-[60] rounded-2xl bg-surface-1 shadow-modal ring-1 ring-border-soft motion-safe:animate-[abha-pop_160ms_ease-out]"
            >
              {place ? (
                <span
                  aria-hidden="true"
                  style={place.side === 'right' || place.side === 'left' ? { top: place.arrow - 7 } : { left: place.arrow - 7 }}
                  className={cn(
                    'absolute h-3.5 w-3.5 rotate-45',
                    place.side === 'right' && '-left-1.5',
                    place.side === 'left' && '-right-1.5',
                    place.side === 'below' && '-top-1.5',
                    place.side === 'above' && '-bottom-1.5',
                    place.onHeader ? 'bg-tile-teal' : 'bg-surface-1',
                  )}
                />
              ) : null}

              <div ref={headerRef} className="relative overflow-hidden rounded-t-2xl bg-tile-teal px-4 py-3 text-tile-teal-fg">
                <span className="relative flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15">
                    <HeartPulse className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-2xs font-semibold uppercase tracking-wider text-white/80">Ayushman Bharat Health Account</span>
                    <span className="block text-base font-bold leading-tight">Your Health, One Place</span>
                  </span>
                </span>
              </div>

              <ul className="grid grid-cols-1 gap-1.5 p-3 min-[360px]:grid-cols-2">
                {ABHA_BENEFITS.map(({ text, icon, hue }) => (
                  <li key={text} className="flex items-center gap-2 rounded-xl bg-surface-2 px-2 py-1.5">
                    <SoftIconTile icon={icon} tone={hue} size="sm" />
                    <span className="text-xs font-semibold leading-snug text-ink">{text}</span>
                  </li>
                ))}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
