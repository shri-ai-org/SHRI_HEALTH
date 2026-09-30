/**
 * S-15-04 · the reading workstation — the imaging section's viewer, with the
 * tools a radiologist's workstation has (the overview keeps the compact
 * `StudyViewer`, which only looks):
 *   · navigate — wheel, slider, ‹ ›, arrow keys; cine for a stack or a loop;
 *   · display — zoom (Ctrl+wheel or ±), pan, fit, rotate, flip, invert, and
 *     window/level by dragging (right button, or the W/L tool). The frames were
 *     windowed when they were exported, so W/L here adjusts the display of
 *     that export — the corner says so — and never the stored pixels;
 *   · mark — length, angle, ellipse ROI, arrow, text and pen, in the frame's
 *     own pixels, so a mark stays on what it marks through zoom, rotation and
 *     flip; lengths and areas in mm where the series is calibrated, in pixels
 *     and said to be where it is not; select, delete, undo, redo;
 *   · key images, and a snapshot of the frame with its marks.
 * The AI's marks on a head CT keep their own switch and never mix with the
 * reader's; the reader's marks are theirs, audited, and never part of the
 * report unless typed into it.
 *
 * The contracts other screens and the flows rely on are kept: the frame is a
 * `role="group"` named by `series.label(n)`, the steps are "Previous/Next
 * slice", the AI switch reads "AI overlay on" / "Show the overlay", and two
 * panes can share one frame through `slice` / `onSlice`.
 */

import {
  ArrowUpRight, Camera, ChevronLeft, ChevronRight, Contrast, Eraser, Eye, EyeOff, FlipHorizontal2, FlipVertical2, Hand, Keyboard,
  Maximize, MousePointer2, Pause, PenLine, Play, Redo2, RotateCcw, RotateCw, Ruler, Star, SunMedium, Type, Undo2, ZoomIn, ZoomOut, type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import type { NcctOverlay } from '@/data/strokeai'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { cn } from '../../lib/cn'
import type { SeriesView } from '../../logic/series'
import { useImaging, type Annotation, type ToolKind } from '../../state/imaging'
import { Icon } from '../../ui/primitives'

import { POINTS, TOOL_LABEL, hits, meanInEllipse, measure, type Pt } from './tools'

type Mode = 'pointer' | 'pan' | 'wl' | 'erase' | ToolKind

const MIN_ZOOM = 0.5
const MAX_ZOOM = 8
const FPS = [5, 10, 15, 20] as const

/** The keys, as the Shortcuts list shows them. */
const KEYS: [string, string][] = [
  ['↑ ↓ / wheel', 'Previous / next image'],
  ['+ − / Ctrl+wheel', 'Zoom'],
  ['0', 'Fit'],
  ['R', 'Rotate 90°'],
  ['H · V', 'Flip horizontal · vertical'],
  ['I', 'Invert'],
  ['W', 'Window/level (drag)'],
  ['P', 'Pan'],
  ['L · G · E', 'Length · angle · ellipse'],
  ['A · T · F', 'Arrow · text · pen'],
  ['X', 'Eraser'],
  ['K', 'Key image'],
  ['Space', 'Play / pause'],
  ['Ctrl+Z · Ctrl+Y', 'Undo · redo'],
  ['Del', 'Delete the selected mark'],
  ['Esc', 'Pointer'],
]

const MODE_KEY: Record<string, Mode> = { l: 'length', g: 'angle', e: 'ellipse', a: 'arrow', t: 'text', f: 'pen', x: 'erase', w: 'wl', p: 'pan' }

export function Workstation({
  series,
  studyId,
  overlays = [],
  initialSlice,
  slice: controlled,
  onSlice,
  tools = true,
  className,
}: {
  series: SeriesView
  /** Where the reader's marks and key images are kept. */
  studyId: string
  overlays?: NcctOverlay[]
  initialSlice?: number
  slice?: number
  onSlice?: (n: number) => void
  /** The reading tools; off for a second, look-only pane. */
  tools?: boolean
  className?: string
}) {
  const me = useCurrentStaff()
  const audit = useAudit((s) => s.record)
  const toast = useUI((s) => s.toast)
  const stored = useImaging((s) => s.annotations[studyId])
  const setAnnotations = useImaging((s) => s.setAnnotations)
  const keyImages = useImaging((s) => s.keyImages[studyId])
  const toggleKey = useImaging((s) => s.toggleKey)

  const start = initialSlice ?? (series.kind === 'stack' ? Math.max(1, Math.round(series.frames / 2)) : 1)
  const [own, setOwn] = useState(start)
  const slice = Math.min(series.frames, Math.max(1, controlled ?? own))
  const current = useRef(slice)
  useEffect(() => {
    current.current = slice
  }, [slice])
  const go = useCallback(
    (n: number) => {
      const c = Math.min(series.frames, Math.max(1, n))
      current.current = c
      setOwn(c)
      onSlice?.(c)
    },
    [series.frames, onSlice],
  )
  const step = useCallback((d: number) => go(current.current + d), [go])

  // Display state — the reader's view of the frame, never the frame.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<Pt>([0, 0])
  const [rotation, setRotation] = useState(0)
  const [flip, setFlip] = useState<[boolean, boolean]>([false, false])
  const [invert, setInvert] = useState(false)
  const [wl, setWl] = useState<[number, number]>([0, 0]) // brightness, contrast — percentage points
  const [showAi, setShowAi] = useState(true)
  const [mode, setMode] = useState<Mode>('pointer')
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState<(typeof FPS)[number]>(10)
  const [draft, setDraft] = useState<Pt[] | null>(null)
  const [hover, setHover] = useState<Pt | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [textAt, setTextAt] = useState<Pt | null>(null)
  const [textValue, setTextValue] = useState('')
  const [keysOpen, setKeysOpen] = useState(false)
  const [size, setSize] = useState<Pt>([512, 512])

  const annotations = useMemo(() => stored ?? [], [stored])
  const [history, setHistory] = useState<{ undo: Annotation[][]; redo: Annotation[][] }>({ undo: [], redo: [] })
  const onFrame = annotations.filter((a) => a.frame === slice)
  const isKey = (keyImages ?? []).includes(slice)

  const frameRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  function commit(next: Annotation[], event: 'IMAGING.ANNOTATION_ADDED' | 'IMAGING.ANNOTATION_DELETED', what: string) {
    setHistory((h) => ({ undo: [...h.undo, annotations], redo: [] }))
    setAnnotations(studyId, next)
    audit({ event, actor: me.name, actorId: me.id, subject: studyId, detail: `${studyId} · image ${slice} · ${what}` })
  }
  function undo() {
    const prev = history.undo[history.undo.length - 1]
    if (!prev) return
    setHistory((h) => ({ undo: h.undo.slice(0, -1), redo: [...h.redo, annotations] }))
    setAnnotations(studyId, prev)
  }
  function redo() {
    const next = history.redo[history.redo.length - 1]
    if (!next) return
    setHistory((h) => ({ undo: [...h.undo, annotations], redo: h.redo.slice(0, -1) }))
    setAnnotations(studyId, next)
  }
  function add(tool: ToolKind, points: Pt[], text?: string) {
    const value = tool === 'ellipse' && imgRef.current ? meanInEllipse(imgRef.current, points) : undefined
    const a: Annotation = { id: `${studyId}-${Date.now().toString(36)}`, frame: slice, tool, points, text, value, by: me.name, at: new Date().toISOString() }
    commit([...annotations, a], 'IMAGING.ANNOTATION_ADDED', `${TOOL_LABEL[tool]}${measure(a, series.pixelSpacing, value) ? ` ${measure(a, series.pixelSpacing, value)}` : text ? ` “${text}”` : ''}`)
    setSelected(a.id)
  }
  function remove(id: string) {
    const a = annotations.find((x) => x.id === id)
    if (!a) return
    commit(
      annotations.filter((x) => x.id !== id),
      'IMAGING.ANNOTATION_DELETED',
      `${TOOL_LABEL[a.tool]} by ${a.by}`,
    )
    setSelected(null)
  }
  function markKey() {
    const on = toggleKey(studyId, slice)
    audit({ event: 'IMAGING.KEY_IMAGE', actor: me.name, actorId: me.id, subject: studyId, detail: `${studyId} · image ${slice} ${on ? 'marked' : 'unmarked'} as a key image` })
  }
  function reset() {
    setZoom(1)
    setPan([0, 0])
    setRotation(0)
    setFlip([false, false])
    setInvert(false)
    setWl([0, 0])
  }

  /* The wheel: Ctrl zooms, otherwise it steps the images; never the page. */
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      if (Math.abs(e.deltaY) < 2) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY > 0 ? 0.9 : 1.1))))
        return
      }
      if (series.kind === 'single') return
      e.preventDefault()
      step(e.deltaY > 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [step, series.kind])

  /* Cine: only when asked; with reduced motion Play steps one image instead. */
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  useEffect(() => {
    if (!playing || series.frames < 2) return
    const t = window.setInterval(() => go(current.current >= series.frames ? 1 : current.current + 1), 1000 / fps)
    return () => window.clearInterval(t)
  }, [playing, fps, series.frames, go])

  /** A screen point in the frame's own pixels — through every zoom, pan, rotation and flip. */
  function toImage(clientX: number, clientY: number): Pt | null {
    const svg = svgRef.current
    const m = svg?.getScreenCTM()
    if (!svg || !m) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const r = pt.matrixTransform(m.inverse())
    return [r.x, r.y]
  }

  const drag = useRef<{ kind: 'pan' | 'wl' | 'draw'; x: number; y: number; from: Pt } | null>(null)
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (textAt) return
    frameRef.current?.focus()
    const q = toImage(e.clientX, e.clientY)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (e.button === 2 || mode === 'wl') {
      drag.current = { kind: 'wl', x: e.clientX, y: e.clientY, from: wl }
      return
    }
    if (e.button === 1 || mode === 'pan' || (mode === 'pointer' && !hitAt(q))) {
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, from: pan }
      if (mode === 'pointer') setSelected(null)
      return
    }
    if (!q) return
    if (mode === 'pointer') {
      setSelected(hitAt(q)?.id ?? null)
      return
    }
    if (mode === 'erase') {
      const h = hitAt(q)
      if (h) remove(h.id)
      return
    }
    if (mode === 'text') {
      setTextAt(q)
      setTextValue('')
      return
    }
    if (mode === 'angle') {
      const next = [...(draft ?? []), q]
      if (next.length >= POINTS.angle) {
        add('angle', next)
        setDraft(null)
      } else setDraft(next)
      return
    }
    setDraft([q, q])
    drag.current = { kind: 'draw', x: e.clientX, y: e.clientY, from: q }
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    const q = toImage(e.clientX, e.clientY)
    if (mode === 'angle' && draft) setHover(q)
    if (!d) return
    const w = frameRef.current?.clientWidth ?? 1
    if (d.kind === 'pan') setPan([d.from[0] + ((e.clientX - d.x) / w) * 100, d.from[1] + ((e.clientY - d.y) / w) * 100])
    else if (d.kind === 'wl') setWl([Math.max(-80, Math.min(120, d.from[0] - (e.clientY - d.y) / 2)), Math.max(-80, Math.min(200, d.from[1] + (e.clientX - d.x) / 2))])
    else if (d.kind === 'draw' && q && draft) setDraft(mode === 'pen' ? [...draft, q] : [draft[0], q])
  }
  function onPointerUp() {
    const d = drag.current
    drag.current = null
    if (d?.kind !== 'draw' || !draft) return
    const tool = mode as ToolKind
    const [a, b] = [draft[0], draft[draft.length - 1]]
    // A click without a drag draws nothing — no zero-length marks.
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 2) add(tool, tool === 'pen' ? draft : [a, b])
    setDraft(null)
  }
  function hitAt(q: Pt | null) {
    if (!q) return undefined
    const tol = 8 / zoom
    return [...onFrame].reverse().find((a) => hits(a, q, tol))
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (textAt) return
    const k = e.key.toLowerCase()
    const mod = e.ctrlKey || e.metaKey
    let handled = true
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') step(1)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') step(-1)
    else if (mod && k === 'z') undo()
    else if (mod && k === 'y') redo()
    else if (mod) handled = false
    else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))
    else if (e.key === '-') setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))
    else if (e.key === '0') reset()
    else if (!tools) handled = false
    else if (k === 'r') setRotation((r) => (r + 90) % 360)
    else if (k === 'h') setFlip(([h, v]) => [!h, v])
    else if (k === 'v') setFlip(([h, v]) => [h, !v])
    else if (k === 'i') setInvert((v) => !v)
    else if (k === 'k') markKey()
    else if (e.key === ' ' && series.frames > 1) {
      if (reduced) step(1)
      else setPlaying((p) => !p)
    }
    else if (e.key === 'Escape') {
      setMode('pointer')
      setDraft(null)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) remove(selected)
    else if (MODE_KEY[k]) setMode(MODE_KEY[k])
    else handled = false
    if (handled) e.preventDefault()
  }

  function snapshot() {
    const img = imgRef.current
    if (!img?.naturalWidth) return
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight + 22
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.filter = filter
    ctx.drawImage(img, 0, 0)
    ctx.filter = 'none'
    ctx.strokeStyle = '#fde047'
    ctx.fillStyle = '#fde047'
    ctx.lineWidth = 2
    ctx.font = '12px sans-serif'
    for (const a of onFrame) {
      const p = a.points
      ctx.beginPath()
      if (a.tool === 'ellipse') ctx.ellipse(p[0][0], p[0][1], Math.abs(p[1][0] - p[0][0]), Math.abs(p[1][1] - p[0][1]), 0, 0, Math.PI * 2)
      else if (a.tool !== 'text') p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.stroke()
      const label = a.text ?? measure(a, series.pixelSpacing, a.value)
      if (label) ctx.fillText(label, p[p.length - 1][0] + 6, p[p.length - 1][1] - 6)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    ctx.fillText(`${series.label(slice)} · ${series.credit ?? ''}`, 6, c.height - 7)
    const a = document.createElement('a')
    a.href = c.toDataURL('image/png')
    a.download = `${studyId}-image-${slice}.png`
    a.click()
    toast({ tone: 'success', title: 'Snapshot saved', detail: `${studyId} · image ${slice}, with its marks and the image credit.` })
  }

  const filter = `brightness(${100 + wl[0]}%) contrast(${100 + wl[1]}%)${invert ? ' invert(1)' : ''}`
  const transform = `translate(${pan[0]}%, ${pan[1]}%) rotate(${rotation}deg) scale(${zoom * (flip[0] ? -1 : 1)}, ${zoom * (flip[1] ? -1 : 1)})`
  const activeAi = showAi ? overlays.filter((o) => slice >= o.from && slice <= o.to) : []
  const noun = series.frameWord ?? (series.kind === 'loop' ? 'frame' : 'slice')
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  const displayed = zoom !== 1 || rotation !== 0 || flip[0] || flip[1] || invert || wl[0] !== 0 || wl[1] !== 0
  const cursor = mode === 'pan' ? 'cursor-grab' : mode === 'wl' ? 'cursor-ns-resize' : mode === 'pointer' ? 'cursor-default' : mode === 'erase' ? 'cursor-not-allowed' : 'cursor-crosshair'
  const stroke = 2 / zoom

  return (
    <div className={cn('flex min-w-0 flex-col gap-[10px]', className)}>
      {tools && (
        <div role="toolbar" aria-label="Reading tools" className="flex flex-wrap items-center gap-[4px] rounded-[16px] bg-sh-card p-[6px]">
          <ToolGroup>
            <Tool icon={MousePointer2} label="Pointer — select a mark" keyHint="Esc" on={mode === 'pointer'} onClick={() => setMode('pointer')} />
            <Tool icon={Hand} label="Pan" keyHint="P" on={mode === 'pan'} onClick={() => setMode('pan')} />
            <Tool icon={Contrast} label="Window/level — drag up/down for brightness, sideways for contrast" keyHint="W" on={mode === 'wl'} onClick={() => setMode('wl')} />
          </ToolGroup>
          <ToolGroup>
            <Tool icon={ZoomIn} label="Zoom in" keyHint="+" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))} />
            <Tool icon={ZoomOut} label="Zoom out" keyHint="−" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))} />
            <Tool icon={Maximize} label="Fit and reset the display" keyHint="0" onClick={reset} />
            <Tool icon={RotateCw} label="Rotate 90°" keyHint="R" onClick={() => setRotation((r) => (r + 90) % 360)} />
            <Tool icon={FlipHorizontal2} label="Flip horizontally" keyHint="H" on={flip[0]} onClick={() => setFlip(([h, v]) => [!h, v])} />
            <Tool icon={FlipVertical2} label="Flip vertically" keyHint="V" on={flip[1]} onClick={() => setFlip(([h, v]) => [h, !v])} />
            <Tool icon={SunMedium} label="Invert" keyHint="I" on={invert} onClick={() => setInvert((v) => !v)} />
          </ToolGroup>
          <ToolGroup>
            <Tool icon={Ruler} label="Length" keyHint="L" on={mode === 'length'} onClick={() => setMode('length')} />
            <Tool icon={AngleIcon} label="Angle — three clicks" keyHint="G" on={mode === 'angle'} onClick={() => setMode('angle')} />
            <Tool icon={EllipseIcon} label="Ellipse ROI" keyHint="E" on={mode === 'ellipse'} onClick={() => setMode('ellipse')} />
            <Tool icon={ArrowUpRight} label="Arrow" keyHint="A" on={mode === 'arrow'} onClick={() => setMode('arrow')} />
            <Tool icon={Type} label="Text label" keyHint="T" on={mode === 'text'} onClick={() => setMode('text')} />
            <Tool icon={PenLine} label="Pen" keyHint="F" on={mode === 'pen'} onClick={() => setMode('pen')} />
            <Tool icon={Eraser} label="Eraser — click a mark to delete it" keyHint="X" on={mode === 'erase'} onClick={() => setMode('erase')} />
          </ToolGroup>
          <ToolGroup>
            <Tool icon={Undo2} label="Undo" keyHint="Ctrl+Z" disabled={history.undo.length === 0} onClick={undo} />
            <Tool icon={Redo2} label="Redo" keyHint="Ctrl+Y" disabled={history.redo.length === 0} onClick={redo} />
            <Tool icon={Star} label={isKey ? 'Unmark key image' : 'Mark as key image'} keyHint="K" on={isKey} onClick={markKey} />
            <Tool icon={Camera} label="Save a snapshot with the marks" onClick={snapshot} />
            <span className="relative">
              <Tool icon={Keyboard} label="Keyboard shortcuts" on={keysOpen} onClick={() => setKeysOpen((v) => !v)} />
              {keysOpen && (
                <div role="dialog" aria-label="Keyboard shortcuts" className="absolute right-0 top-[52px] z-20 w-[280px] rounded-[16px] bg-sh-card p-[14px] text-[12px] shadow-lg ring-1 ring-sh-line">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-[12px] gap-y-[6px]">
                    {KEYS.map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="font-mono font-semibold text-sh-text">{k}</dt>
                        <dd className="text-sh-text-2">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </span>
          </ToolGroup>
        </div>
      )}

      <div
        ref={frameRef}
        tabIndex={0}
        role="group"
        aria-label={series.label(slice)}
        aria-describedby={`${studyId}-ws-help`}
        onKeyDown={onKey}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        className={cn('relative mx-auto aspect-square w-full max-w-[min(100%,74vh)] touch-none overflow-hidden rounded-[16px] bg-black outline-none focus-visible:ring-2 focus-visible:ring-sh-accent', cursor)}
      >
        <span id={`${studyId}-ws-help`} className="sr-only">
          Arrow keys step the images; the toolbar and its letters choose a tool; marks are kept with the study.
        </span>
        <div className="absolute inset-0" style={{ transform, transformOrigin: '50% 50%' }}>
          <img
            ref={imgRef}
            src={series.path(slice)}
            alt={series.alt(slice)}
            draggable={false}
            onLoad={(e) => setSize([e.currentTarget.naturalWidth || 512, e.currentTarget.naturalHeight || 512])}
            className="absolute inset-0 size-full select-none object-contain"
            style={{ filter }}
          />
          {/* The reader's marks, in the frame's own pixels. */}
          <svg ref={svgRef} viewBox={`0 0 ${size[0]} ${size[1]}`} preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
            {onFrame.map((a) => (
              <Mark key={a.id} a={a} selected={a.id === selected} stroke={stroke} label={a.text ?? measure(a, series.pixelSpacing, a.value)} zoom={zoom} />
            ))}
            {draft && <Mark a={{ id: 'draft', frame: slice, tool: mode as ToolKind, points: mode === 'angle' && hover ? [...draft, hover] : draft, by: '', at: '' }} stroke={stroke} label={measure({ tool: mode as ToolKind, points: draft }, series.pixelSpacing)} zoom={zoom} draft />}
          </svg>
          {/* AIP-04 — the AI's marks, over the image and off it completely with one switch; never mixed with the reader's. */}
          {activeAi.length > 0 && (
            <svg data-ncct-overlay viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
              {activeAi.map((o) => (
                <ellipse key={o.label} cx={o.cx * 100} cy={o.cy * 100} rx={o.rx * 100} ry={o.ry * 100} fill="none" stroke={o.tone === 'critical' ? 'var(--on-image-crit)' : 'var(--on-image-ai)'} strokeWidth="2.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
          )}
          {activeAi.map((o) => (
            <span
              key={o.label}
              data-ncct-overlay
              style={{ left: `${o.cx * 100}%`, top: `${(o.cy - o.ry) * 100}%`, color: o.tone === 'critical' ? 'var(--on-image-crit)' : 'var(--on-image-ai)', transform: `translate(-50%, -140%) scale(${1 / zoom})`, transformOrigin: '50% 100%' }}
              className="pointer-events-none absolute whitespace-nowrap rounded-[6px] bg-black/80 px-[6px] py-[2px] text-[10.5px] font-bold tracking-[0.04em]"
            >
              {o.label}
            </span>
          ))}
        </div>

        {/* The text tool's field, where the click was. */}
        {textAt && (
          <form
            className="absolute left-1/2 top-[12px] z-10 flex -translate-x-1/2 items-center gap-[6px] rounded-[12px] bg-black/85 p-[6px]"
            onPointerDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              if (textValue.trim()) add('text', [textAt], textValue.trim())
              setTextAt(null)
              frameRef.current?.focus()
            }}
          >
            <label className="sr-only" htmlFor={`${studyId}-ws-text`}>
              Label text
            </label>
            <input id={`${studyId}-ws-text`} autoFocus value={textValue} onChange={(e) => setTextValue(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setTextAt(null)} placeholder="Label" className="h-[36px] w-[180px] rounded-[8px] bg-white/10 px-[8px] text-[13px] text-white placeholder:text-white/50" />
            <button type="submit" className="h-[36px] rounded-[8px] bg-white/20 px-[10px] text-[13px] font-medium text-white">
              Place
            </button>
          </form>
        )}

        {/* Corner text, the way a reading workstation lays it out. */}
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
          <span className="block">{series.pixelSpacing ? `${series.pixelSpacing[1].toFixed(3)} mm/px` : 'uncalibrated'}</span>
        </p>
        <p className="pointer-events-none absolute bottom-[8px] left-[12px] text-[11px] tabular-nums text-(--on-image-ink)">
          {series.kind === 'single' ? '1 image' : `${series.kind === 'loop' ? 'Frame' : 'Im'} ${slice} / ${series.frames}`}
          {series.frameNote?.(slice) ? ` · ${series.frameNote(slice)}` : ''}
          {isKey ? ' · ★ key image' : ''}
        </p>
        <p className="pointer-events-none absolute bottom-[8px] right-[12px] text-right text-[11px]/[1.35] tabular-nums text-(--on-image-ink)">
          {activeAi.length > 0 && <span className="block font-semibold text-(--on-image-ai)">AI overlay on</span>}
          {displayed && (
            <span className="block">
              Zoom {Math.round(zoom * 100)}%{rotation ? ` · ${rotation}°` : ''}
              {flip[0] || flip[1] ? ' · flipped' : ''}
              {invert ? ' · inverted' : ''}
              {wl[0] || wl[1] ? ` · display W/L ${wl[1] >= 0 ? '+' : ''}${Math.round(wl[1])}/${wl[0] >= 0 ? '+' : ''}${Math.round(wl[0])}` : ''}
            </span>
          )}
        </p>
      </div>

      {/* Navigation, and the AI switch where there are AI marks — removing them is the reader's right. */}
      <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[10px]">
        {overlays.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAi((v) => !v)}
            aria-pressed={showAi}
            className={cn('inline-flex h-[44px] items-center gap-[6px] rounded-full px-[14px] text-[13px] font-semibold transition-colors duration-150', showAi ? 'bg-sh-pend-bg text-sh-pend-fg' : 'bg-sh-control text-sh-text-2 hover:text-sh-text')}
          >
            <Icon icon={showAi ? Eye : EyeOff} size={15} />
            {showAi ? 'AI overlay on' : 'Show the overlay'}
          </button>
        )}
        {series.frames > 1 && (
          <>
            <button
              type="button"
              onClick={() => (reduced ? step(1) : setPlaying((v) => !v))}
              aria-pressed={playing}
              aria-label={playing ? 'Pause' : 'Play'}
              className="inline-flex size-[44px] items-center justify-center rounded-full bg-sh-control text-sh-text-2 hover:bg-sh-hover"
            >
              <Icon icon={playing ? Pause : Play} size={16} />
            </button>
            <label className="inline-flex h-[44px] items-center gap-[6px] rounded-full bg-sh-control px-[12px] text-[13px] text-sh-text-2">
              <span className="sr-only">Cine speed</span>
              <select value={fps} onChange={(e) => setFps(Number(e.target.value) as (typeof FPS)[number])} className="bg-transparent text-sh-text" aria-label="Cine speed">
                {FPS.map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>
            <span className="inline-flex items-center rounded-full bg-sh-control">
              <button type="button" onClick={() => step(-1)} disabled={slice <= 1} aria-label={`Previous ${noun}`} className="inline-flex size-[44px] items-center justify-center rounded-full text-sh-text-2 hover:bg-sh-hover disabled:opacity-40">
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
                className="h-[44px] w-[160px] accent-(--ai)"
              />
              <button type="button" onClick={() => step(1)} disabled={slice >= series.frames} aria-label={`Next ${noun}`} className="inline-flex size-[44px] items-center justify-center rounded-full text-sh-text-2 hover:bg-sh-hover disabled:opacity-40">
                <Icon icon={ChevronRight} size={16} />
              </button>
            </span>
            <span className="text-[13px] tabular-nums text-sh-text-2">
              {slice} / {series.frames}
            </span>
          </>
        )}
        {tools && displayed && (
          <button type="button" onClick={reset} className="ml-auto inline-flex h-[44px] items-center gap-[6px] rounded-full bg-sh-control px-[14px] text-[13px] font-medium text-sh-text-2 hover:bg-sh-hover">
            <Icon icon={RotateCcw} size={15} /> Reset display
          </button>
        )}
      </div>

      {overlays.length > 0 && (
        <p className="text-[12px] tabular-nums text-sh-text-3">{overlays.map((o) => `${o.label.charAt(0)}${o.label.slice(1).toLowerCase()} · slices ${o.from}–${o.to}`).join(' · ')}</p>
      )}
      {series.credit && <p className="text-[11px] text-sh-text-3">{series.credit}</p>}
    </div>
  )
}

function ToolGroup({ children }: { children: ReactNode }) {
  return <span className="flex items-center gap-[2px] border-sh-line pr-[4px] [&:not(:last-child)]:border-r">{children}</span>
}

function Tool({ icon, label, keyHint, on, disabled, onClick }: { icon: LucideIcon | ((p: { size?: number }) => ReactNode); label: string; keyHint?: string; on?: boolean; disabled?: boolean; onClick: () => void }) {
  const I = icon as LucideIcon
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={keyHint ? `${label} (${keyHint})` : label}
      title={keyHint ? `${label} · ${keyHint}` : label}
      aria-pressed={on === undefined ? undefined : on}
      className={cn(
        'inline-flex size-[44px] items-center justify-center rounded-[12px] transition-colors duration-150 disabled:opacity-40',
        on ? 'bg-sh-primary text-sh-on-primary' : 'text-sh-text-2 hover:bg-sh-hover hover:text-sh-text',
      )}
    >
      <I size={18} />
    </button>
  )
}

function AngleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20 L20 20 M4 20 L15 5" />
      <path d="M10 20 A6 6 0 0 0 8.5 14" />
    </svg>
  )
}

function EllipseIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <ellipse cx="12" cy="12" rx="9" ry="6" />
    </svg>
  )
}

/** One of the reader's marks, drawn in the frame's pixels; its readout keeps its size as the image zooms. */
function Mark({ a, selected, draft, stroke, label, zoom }: { a: Annotation; selected?: boolean; draft?: boolean; stroke: number; label?: string; zoom: number }) {
  const p = a.points
  const color = draft ? 'var(--on-image-ink)' : selected ? 'var(--on-image-crit)' : 'var(--on-image-mark)'
  const common = { fill: 'none', stroke: color, strokeWidth: stroke * (selected ? 1.6 : 1), strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const last = p[p.length - 1]
  const font = 12 / zoom
  let shape: ReactNode = null
  if (a.tool === 'ellipse' && p.length === 2) shape = <ellipse cx={p[0][0]} cy={p[0][1]} rx={Math.abs(p[1][0] - p[0][0])} ry={Math.abs(p[1][1] - p[0][1])} {...common} />
  else if (a.tool === 'arrow' && p.length === 2) {
    const ang = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0])
    const h = 10 / zoom
    shape = (
      <>
        <line x1={p[0][0]} y1={p[0][1]} x2={p[1][0]} y2={p[1][1]} {...common} />
        <path d={`M${p[1][0]} ${p[1][1]} L${p[1][0] - h * Math.cos(ang - 0.45)} ${p[1][1] - h * Math.sin(ang - 0.45)} M${p[1][0]} ${p[1][1]} L${p[1][0] - h * Math.cos(ang + 0.45)} ${p[1][1] - h * Math.sin(ang + 0.45)}`} {...common} />
      </>
    )
  } else if (a.tool === 'text') shape = <circle cx={p[0][0]} cy={p[0][1]} r={3 / zoom} fill={color} />
  else shape = <polyline points={p.map((q) => q.join(',')).join(' ')} {...common} />
  return (
    <g>
      {shape}
      {a.tool === 'length' && p.length === 2 && p.map((q, i) => <circle key={i} cx={q[0]} cy={q[1]} r={2.5 / zoom} fill={color} />)}
      {label && (
        <text x={last[0] + 6 / zoom} y={last[1] - 6 / zoom} fill={color} fontSize={font} fontWeight={600} paintOrder="stroke" stroke="black" strokeWidth={3 / zoom}>
          {label}
        </text>
      )}
    </g>
  )
}
