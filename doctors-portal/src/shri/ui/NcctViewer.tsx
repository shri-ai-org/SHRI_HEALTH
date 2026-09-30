/**
 * The study viewer — the one imaging surface in the product, used by the
 * record's Report viewer, the imaging study (S-15-04), the Stroke-AI Console
 * (S-18-21) and the non-LVO triage (S-18-14 to 16). Ported from
 * `src/components/ncct.tsx` (NcctViewer :41) and generalised to every
 * modality this build has real pixels for (`src/data/imaging.generated.ts`):
 *   · a STACK (CT, MRI) — wheel, slider, ‹ › and the arrow keys step slices;
 *   · a SINGLE image (X-ray) — zoom, and drag to pan while zoomed;
 *   · a LOOP (ultrasound, echo) — play/pause and step frame by frame; it never
 *     starts on its own, and under reduced motion Play steps one frame.
 * Every frame is a PNG exported at import time and loaded at runtime, never
 * bundled; the window the pixels were exported with is stated on the frame,
 * and so is where the image came from (its dataset and licence).
 *
 * The rules it keeps: the UNMARKED image is always one control away (AIP-04);
 * the AI marks a region and never writes a diagnosis on the image; the frame
 * is black in both themes, its chrome measured against the image. A new
 * series starts afresh (its middle, or its finding; unzoomed; marks on); the
 * wheel steps the stack without scrolling the page; marks zoom with the image;
 * there is no overlay switch without a mark. Two panes can share one frame
 * through `slice` / `onSlice`.
 *
 * `NcctViewer` is the head-CT face of it, unchanged for its callers.
 */

import { ChevronLeft, ChevronRight, Eye, EyeOff, Pause, Play, Scan, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

import type { NcctStudy } from '@/data/ncct.generated'
import type { NcctOverlay } from '@/data/strokeai'

import { cn } from '../lib/cn'
import { ncctView, type SeriesView } from '../logic/series'

import { Icon } from './primitives'

/** The overlay type is the data's (`src/data/strokeai.ts`), defined once. */
export type { NcctOverlay }

const ZOOMS = [1, 1.5, 2] as const
const LOOP_MS = 90

export function StudyViewer({
  series,
  overlays = [],
  footer,
  initialSlice,
  slice: controlled,
  onSlice,
  className,
  compact,
}: {
  series: SeriesView
  overlays?: NcctOverlay[]
  /** Rendered under the image — the model line, the attest bar. */
  footer?: ReactNode
  initialSlice?: number
  /** A frame held by the caller, so two panes move together. */
  slice?: number
  onSlice?: (slice: number) => void
  className?: string
  /** A narrow frame — a shorter slider and an icon-only zoom, so the controls stay on one line. */
  compact?: boolean
}) {
  const start = initialSlice ?? (series.kind === 'stack' ? Math.max(1, Math.round(series.frames / 2)) : 1)
  const [own, setOwn] = useState(start)
  const [showOverlay, setShowOverlay] = useState(true)
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [playing, setPlaying] = useState(false)
  // A different series starts afresh — its middle (or its finding), unzoomed, marks on, paused.
  const [forSeries, setForSeries] = useState(series.key)
  if (forSeries !== series.key) {
    setForSeries(series.key)
    setOwn(start)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setShowOverlay(true)
    setPlaying(false)
  }

  const slice = Math.min(series.frames, Math.max(1, controlled ?? own))
  const frame = useRef<HTMLDivElement>(null)
  // The frame as of the last step, not the last render — a fast wheel sends several events between renders.
  const current = useRef(slice)
  useEffect(() => {
    current.current = slice
  }, [slice])

  const go = useCallback(
    (next: number) => {
      const clamped = Math.min(series.frames, Math.max(1, next))
      current.current = clamped
      setOwn(clamped)
      onSlice?.(clamped)
    },
    [series.frames, onSlice],
  )
  const step = useCallback((delta: number) => go(current.current + delta), [go])

  /* The wheel steps the stack, as it does in every reading room — and only the
     stack: a non-passive listener, so the page does not scroll underneath. */
  useEffect(() => {
    const el = frame.current
    if (!el || series.kind === 'single') return
    function onWheel(e: WheelEvent) {
      if (Math.abs(e.deltaY) < 2) return
      e.preventDefault()
      step(e.deltaY > 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [step, series.kind])

  /* A loop plays only when asked, and wraps; with reduced motion Play steps one frame instead. */
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  useEffect(() => {
    if (!playing || series.kind !== 'loop') return
    const t = window.setInterval(() => go(current.current >= series.frames ? 1 : current.current + 1), LOOP_MS)
    return () => window.clearInterval(t)
  }, [playing, series.kind, series.frames, go])

  /* Zoomed in, a drag pans the image; unzoomed there is nothing to pan. */
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (zoom === 1) return
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d || !frame.current) return
    const w = frame.current.clientWidth
    const lim = ((zoom - 1) / 2) * 100
    const clamp = (v: number) => Math.max(-lim, Math.min(lim, v))
    setPan({ x: clamp(d.px + ((e.clientX - d.x) / w) * 100), y: clamp(d.py + ((e.clientY - d.y) / w) * 100) })
  }
  function onPointerUp() {
    drag.current = null
  }

  const active = showOverlay ? overlays.filter((o) => slice >= o.from && slice <= o.to) : []
  const marked = overlays.length > 0
  const first = overlays[0]
  const noun = series.frameWord ?? (series.kind === 'loop' ? 'frame' : 'slice')
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)

  return (
    <div className={cn('min-w-0', className)}>
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={series.label(slice)}
        onKeyDown={(e) => {
          if (series.kind === 'single') return
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault()
            step(1)
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault()
            step(-1)
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn('relative aspect-square w-full touch-pan-y overflow-hidden rounded-[16px] bg-black', zoom > 1 && 'cursor-grab active:cursor-grabbing')}
      >
        {/* The image and its marks zoom (and pan) together, so a mark stays on what it marks. */}
        <div className="absolute inset-0 transition-transform duration-150 motion-reduce:transition-none" style={{ transform: `translate(${pan.x}%, ${pan.y}%) scale(${zoom})` }}>
          <img src={series.path(slice)} alt={series.alt(slice)} draggable={false} className="absolute inset-0 size-full select-none object-contain" />
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
          {series.topLeft.map((t, i) => (
            <span key={i} className="block">
              {t}
            </span>
          ))}
        </p>
        <p className="pointer-events-none absolute right-[12px] top-[8px] text-right text-[11px]/[1.35] tabular-nums text-(--on-image-ink)">
          {series.topRight.map((t, i) => (
            <span key={i} className="block">
              {t}
            </span>
          ))}
        </p>
        <p className="pointer-events-none absolute bottom-[8px] left-[12px] text-[11px] tabular-nums text-(--on-image-ink)">
          {series.kind === 'single' ? '1 image' : `${series.kind === 'loop' ? 'Frame' : 'Im'} ${slice} / ${series.frames}`}
          {series.frameNote?.(slice) ? ` · ${series.frameNote(slice)}` : ''}
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

        {series.kind === 'loop' && (
          <button
            type="button"
            onClick={() => (reduced ? step(1) : setPlaying((v) => !v))}
            aria-pressed={playing}
            aria-label={playing ? 'Pause' : 'Play'}
            className="inline-flex size-[44px] items-center justify-center rounded-full bg-sh-control text-sh-text-2 hover:bg-sh-hover"
          >
            <Icon icon={playing ? Pause : Play} size={16} />
          </button>
        )}

        {series.kind !== 'single' && (
          <span className="inline-flex items-center rounded-full bg-sh-control">
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={slice <= 1}
              aria-label={`Previous ${noun}`}
              className="inline-flex size-[44px] items-center justify-center rounded-full text-sh-text-2 hover:bg-sh-hover disabled:opacity-40"
            >
              <Icon icon={ChevronLeft} size={16} />
            </button>
            <input
              type="range"
              min={1}
              max={series.frames}
              value={slice}
              onChange={(e) => go(Number(e.target.value))}
              aria-label={Noun}
              aria-valuetext={`${Noun} ${slice} of ${series.frames}`}
              className={cn('h-[44px] accent-(--ai)', compact ? 'w-[72px]' : 'w-[128px]')}
            />
            <button
              type="button"
              onClick={() => step(1)}
              disabled={slice >= series.frames}
              aria-label={`Next ${noun}`}
              className="inline-flex size-[44px] items-center justify-center rounded-full text-sh-text-2 hover:bg-sh-hover disabled:opacity-40"
            >
              <Icon icon={ChevronRight} size={16} />
            </button>
          </span>
        )}

        {/* The frame's own "Im n / N" says it in a narrow card; the slider reads it out either way. */}
        {!compact && series.kind !== 'single' && (
          <span className="text-[13px] tabular-nums text-sh-text-2">
            {slice} / {series.frames}
          </span>
        )}

        <button
          type="button"
          onClick={() => {
            setZoom((z) => ZOOMS[(ZOOMS.indexOf(z) + 1) % ZOOMS.length])
            setPan({ x: 0, y: 0 })
          }}
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

      {series.credit && <p className="mt-[6px] text-[11px] text-sh-text-3">{series.credit}</p>}

      {footer}
    </div>
  )
}

/** The head-CT viewer, as every stroke and imaging screen calls it. */
export function NcctViewer({ study, ...rest }: { study: NcctStudy } & Omit<Parameters<typeof StudyViewer>[0], 'series'>) {
  return <StudyViewer series={ncctView(study)} {...rest} />
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
