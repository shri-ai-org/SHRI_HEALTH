/**
 * The NCCT viewer — ported from `src/components/ncct.tsx` (NcctViewer :41),
 * the one imaging surface in the product, used by the record's Report viewer,
 * the imaging study (S-15-04), the Stroke-AI Console (S-18-21) and the non-LVO
 * triage (S-18-14 to 16).
 *
 * Real head-CT pixels, windowed to W 80 / L 40 at import (`scripts/ncct-
 * import.mjs`) and served as PNG slices; the window is stated on the frame.
 * The rules it keeps: the UNMARKED image is always one control away (AIP-04);
 * the AI marks a region and never writes a diagnosis on the image; the frame
 * is black in both themes, its chrome measured against the image.
 *
 * Every control the old viewer had is here — wheel, slider, ‹ › (disabled at
 * the ends), ↑→ / ↓← while focused, zoom 1 → 1.5 → 2, the overlay switch, the
 * corner text. Where the old one fell short: its marks stayed put while the
 * image zoomed under them (here they zoom with it); it kept the last study's
 * slice and zoom when handed another (here a new study starts afresh); the
 * wheel stepped a slice and scrolled the page at once (here it steps only);
 * and its switch said "AI overlay on" over a study with nothing marked (here
 * there is no switch without a mark). Two panes can share one slice through
 * `slice` / `onSlice`.
 */

import { ChevronLeft, ChevronRight, Eye, EyeOff, Scan, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { NCCT_WINDOW, slicePath, type NcctStudy } from '@/data/ncct.generated'
import type { NcctOverlay } from '@/data/strokeai'

import { cn } from '../lib/cn'

import { Icon } from './primitives'

/** The overlay type is the data's (`src/data/strokeai.ts`), defined once. */
export type { NcctOverlay }

const ZOOMS = [1, 1.5, 2] as const

export function NcctViewer({
  study,
  overlays = [],
  footer,
  initialSlice,
  slice: controlled,
  onSlice,
  className,
  compact,
}: {
  study: NcctStudy
  overlays?: NcctOverlay[]
  /** Rendered under the image — the model line, the attest bar. */
  footer?: ReactNode
  initialSlice?: number
  /** A slice held by the caller, so two panes move together. */
  slice?: number
  onSlice?: (slice: number) => void
  className?: string
  /** A narrow frame — a shorter slider and an icon-only zoom, so the controls stay on one line. */
  compact?: boolean
}) {
  const start = initialSlice ?? Math.max(1, Math.round(study.slices / 2))
  const [own, setOwn] = useState(start)
  const [showOverlay, setShowOverlay] = useState(true)
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1)
  // A different study starts afresh — its middle (or its finding), unzoomed, marks on.
  const [forStudy, setForStudy] = useState(study.key)
  if (forStudy !== study.key) {
    setForStudy(study.key)
    setOwn(start)
    setZoom(1)
    setShowOverlay(true)
  }

  const slice = Math.min(study.slices, Math.max(1, controlled ?? own))
  const frame = useRef<HTMLDivElement>(null)
  // The slice as of the last step, not the last render — a fast wheel sends several events between renders.
  const current = useRef(slice)
  useEffect(() => {
    current.current = slice
  }, [slice])

  const go = useCallback(
    (next: number) => {
      const clamped = Math.min(study.slices, Math.max(1, next))
      current.current = clamped
      setOwn(clamped)
      onSlice?.(clamped)
    },
    [study.slices, onSlice],
  )
  const step = useCallback((delta: number) => go(current.current + delta), [go])

  /* The wheel steps the stack, as it does in every reading room — and only the
     stack: a non-passive listener, so the page does not scroll underneath. */
  useEffect(() => {
    const el = frame.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      if (Math.abs(e.deltaY) < 2) return
      e.preventDefault()
      step(e.deltaY > 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [step])

  const active = showOverlay ? overlays.filter((o) => slice >= o.from && slice <= o.to) : []
  const marked = overlays.length > 0
  const first = overlays[0]

  return (
    <div className={cn('min-w-0', className)}>
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={`Non-contrast CT head, slice ${slice} of ${study.slices}`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault()
            step(1)
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault()
            step(-1)
          }
        }}
        className="relative aspect-square w-full touch-pan-y overflow-hidden rounded-[16px] bg-black"
      >
        {/* The image and its marks zoom together, so a mark stays on what it marks. */}
        <div className="absolute inset-0 transition-transform duration-150 motion-reduce:transition-none" style={{ transform: `scale(${zoom})` }}>
          <img
            src={slicePath(study.key, slice)}
            alt={`Axial non-contrast CT, slice ${slice} of ${study.slices}`}
            draggable={false}
            className="absolute inset-0 size-full select-none object-contain"
          />
          {/* AIP-04 — the mark sits OVER the image and lifts off it completely. */}
          {active.length > 0 && (
            <svg data-ncct-overlay viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
              {active.map((o) => (
                <ellipse
                  key={o.label}
                  cx={o.cx * 100}
                  cy={o.cy * 100}
                  rx={o.rx * 100}
                  ry={o.ry * 100}
                  fill="none"
                  stroke={o.tone === 'critical' ? 'var(--on-image-crit)' : 'var(--on-image-ai)'}
                  strokeWidth="2.5"
                  strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          )}
          {/* The label is HTML on its own dark plate — SVG text over bright brain measured 1.76:1. It keeps its size as the image zooms. */}
          {active.map((o) => (
            <span
              key={o.label}
              data-ncct-overlay
              style={{
                left: `${o.cx * 100}%`,
                top: `${(o.cy - o.ry) * 100}%`,
                color: o.tone === 'critical' ? 'var(--on-image-crit)' : 'var(--on-image-ai)',
                transform: `translate(-50%, -140%) scale(${1 / zoom})`,
                transformOrigin: '50% 100%',
              }}
              className="pointer-events-none absolute whitespace-nowrap rounded-[6px] bg-black/80 px-[6px] py-[2px] text-[10.5px] font-bold tracking-[0.04em]"
            >
              {o.label}
            </span>
          ))}
        </div>

        {/* Corner metadata, the way a reading workstation lays it out. */}
        <p className="pointer-events-none absolute left-[12px] top-[8px] text-[11px]/[1.35] text-(--on-image-ink)">
          NCCT head · axial
          <br />
          {study.seriesDescription}
        </p>
        <p className="pointer-events-none absolute right-[12px] top-[8px] text-right text-[11px]/[1.35] tabular-nums text-(--on-image-ink)">
          {study.sliceThickness} mm · {study.kvp} kV
          <br />W {NCCT_WINDOW.width} : L {NCCT_WINDOW.level}
        </p>
        <p className="pointer-events-none absolute bottom-[8px] left-[12px] text-[11px] tabular-nums text-(--on-image-ink)">
          Im {slice} / {study.slices}
        </p>
        {active.length > 0 && <p className="pointer-events-none absolute bottom-[8px] right-[12px] text-[11px] font-semibold text-(--on-image-ai)">AI overlay on</p>}
      </div>

      {/* Controls. The overlay switch is first, because removing it is the reader's right. */}
      <div className="mt-[10px] flex flex-wrap items-center gap-x-[8px] gap-y-[10px]">
        {marked && (
          <button
            type="button"
            onClick={() => setShowOverlay((v) => !v)}
            aria-pressed={showOverlay}
            className={cn(
              'inline-flex h-[44px] items-center gap-[6px] rounded-full px-[14px] text-[13px] font-semibold transition-colors duration-150',
              showOverlay ? 'bg-sh-pend-bg text-sh-pend-fg' : 'bg-sh-control text-sh-text-2 hover:text-sh-text',
            )}
          >
            <Icon icon={showOverlay ? Eye : EyeOff} size={15} />
            {showOverlay ? 'AI overlay on' : 'Show the overlay'}
          </button>
        )}

        <span className="inline-flex items-center rounded-full bg-sh-control">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={slice <= 1}
            aria-label="Previous slice"
            className="inline-flex size-[44px] items-center justify-center rounded-full text-sh-text-2 hover:bg-sh-hover disabled:opacity-40"
          >
            <Icon icon={ChevronLeft} size={16} />
          </button>
          <input
            type="range"
            min={1}
            max={study.slices}
            value={slice}
            onChange={(e) => go(Number(e.target.value))}
            aria-label="Slice"
            aria-valuetext={`Slice ${slice} of ${study.slices}`}
            className={cn('h-[44px] accent-(--ai)', compact ? 'w-[72px]' : 'w-[128px]')}
          />
          <button
            type="button"
            onClick={() => step(1)}
            disabled={slice >= study.slices}
            aria-label="Next slice"
            className="inline-flex size-[44px] items-center justify-center rounded-full text-sh-text-2 hover:bg-sh-hover disabled:opacity-40"
          >
            <Icon icon={ChevronRight} size={16} />
          </button>
        </span>

        {/* The frame's own "Im n / N" says it in a narrow card; the slider reads it out either way. */}
        {!compact && (
          <span className="text-[13px] tabular-nums text-sh-text-2">
            {slice} / {study.slices}
          </span>
        )}

        <button
          type="button"
          onClick={() => setZoom((z) => ZOOMS[(ZOOMS.indexOf(z) + 1) % ZOOMS.length])}
          aria-label={zoom === 1 ? 'Zoom' : `Zoom ${Math.round(zoom * 100)}%`}
          title={zoom === 1 ? 'Zoom' : `Zoom ${Math.round(zoom * 100)}%`}
          className={cn(
            'ml-auto inline-flex h-[44px] items-center justify-center gap-[6px] rounded-full bg-sh-control text-[13px] font-medium text-sh-text-2 hover:bg-sh-hover',
            compact ? 'min-w-[44px] px-[10px]' : 'px-[14px]',
          )}
        >
          <Icon icon={Scan} size={15} />
          {(!compact || zoom !== 1) && (zoom === 1 ? 'Zoom' : `${Math.round(zoom * 100)}%`)}
        </button>
      </div>

      {/* Where the marks are, so a reader who scrolled away can find them again. */}
      {marked && first && (
        <p className="mt-[6px] text-[12px] tabular-nums text-sh-text-3">
          {overlays.map((o) => `${o.label.charAt(0)}${o.label.slice(1).toLowerCase()} · slices ${o.from}–${o.to}`).join(' · ')}
        </p>
      )}

      {footer}
    </div>
  )
}

/**
 * Where the viewer's image would be, when there is no image to show: the same
 * square frame, neutral rather than black — an icon and one factual line, so
 * the doctor always knows where imaging appears, and nothing that could be
 * mistaken for a picture. Never a broken frame, never a fabricated image.
 */
export function ViewerPlaceholder({ icon, line, fill, className }: { icon: LucideIcon; line: string; fill?: boolean; className?: string }) {
  return (
    <div
      role="img"
      aria-label={line}
      // `fill`: in a card, the frame takes the height the card has, so a taller row never leaves a hole under it.
      className={cn('flex w-full flex-col items-center justify-center gap-[10px] rounded-[16px] bg-sh-inner px-[16px] text-center', fill ? 'min-h-[220px] flex-1' : 'aspect-square', className)}
    >
      <span className="inline-flex size-[44px] items-center justify-center rounded-full bg-sh-card text-sh-text-3" aria-hidden="true">
        <Icon icon={icon} size={20} />
      </span>
      <span className="text-[13px] text-sh-text-2">{line}</span>
    </div>
  )
}
