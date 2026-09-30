/**
 * The reading tools' geometry, in the exported frame's pixels: how many
 * points each tool takes, what a mark measures, and what a click near it hits.
 * A length or an area is in mm only where the series carries its calibration
 * (`SeriesView.pixelSpacing`); otherwise it is in pixels and says so.
 */

import type { Annotation, ToolKind } from '../../state/imaging'

export type Pt = [number, number]

/** Points that finish a mark; pen and text finish on their own terms. */
export const POINTS: Record<ToolKind, number> = { length: 2, angle: 3, ellipse: 2, arrow: 2, text: 1, pen: Infinity }

export const TOOL_LABEL: Record<ToolKind, string> = { length: 'Length', angle: 'Angle', ellipse: 'Ellipse ROI', arrow: 'Arrow', text: 'Text', pen: 'Pen' }

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The measurement a mark reads out, calibrated where the series allows. */
export function measure(a: Pick<Annotation, 'tool' | 'points'>, spacing?: [number, number], mean?: number): string | undefined {
  const s = spacing ? (spacing[0] + spacing[1]) / 2 : undefined
  const p = a.points
  switch (a.tool) {
    case 'length': {
      if (p.length < 2) return undefined
      const d = dist(p[0], p[1])
      return s ? `${(d * s).toFixed(1)} mm` : `${Math.round(d)} px · uncalibrated`
    }
    case 'angle': {
      if (p.length < 3) return undefined
      const v1 = [p[0][0] - p[1][0], p[0][1] - p[1][1]]
      const v2 = [p[2][0] - p[1][0], p[2][1] - p[1][1]]
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) || 1)
      return `${((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI).toFixed(1)}°`
    }
    case 'ellipse': {
      if (p.length < 2) return undefined
      const rx = Math.abs(p[1][0] - p[0][0])
      const ry = Math.abs(p[1][1] - p[0][1])
      const area = Math.PI * rx * ry
      const size = s ? `${(area * s * s).toFixed(0)} mm²` : `${Math.round(area)} px² · uncalibrated`
      return mean === undefined ? size : `${size} · mean ${mean.toFixed(0)} (display)`
    }
    default:
      return undefined
  }
}

/** Distance from a point to a segment, for hit-testing. */
function toSegment(q: Pt, a: Pt, b: Pt): number {
  const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
  if (l2 === 0) return dist(q, a)
  const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / l2))
  return dist(q, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
}

/** Whether a click at `q` hits a mark, within `tol` frame pixels. */
export function hits(a: Annotation, q: Pt, tol: number): boolean {
  const p = a.points
  if (a.tool === 'ellipse' && p.length === 2) {
    const rx = Math.abs(p[1][0] - p[0][0]) || 1
    const ry = Math.abs(p[1][1] - p[0][1]) || 1
    const r = Math.hypot((q[0] - p[0][0]) / rx, (q[1] - p[0][1]) / ry)
    return Math.abs(r - 1) * Math.min(rx, ry) < tol || r < 1
  }
  if (a.tool === 'text') return dist(q, p[0]) < tol * 3
  for (let i = 1; i < p.length; i++) if (toSegment(q, p[i - 1], p[i]) < tol) return true
  return p.length === 1 && dist(q, p[0]) < tol
}

/** The mean display value (0–255) inside an ellipse, sampled from the frame as shown. */
export function meanInEllipse(img: HTMLImageElement, p: Pt[]): number | undefined {
  if (p.length < 2 || !img.naturalWidth) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return undefined
  ctx.drawImage(img, 0, 0)
  const [cx, cy] = p[0]
  const rx = Math.max(1, Math.abs(p[1][0] - cx))
  const ry = Math.max(1, Math.abs(p[1][1] - cy))
  const x0 = Math.max(0, Math.floor(cx - rx))
  const y0 = Math.max(0, Math.floor(cy - ry))
  const w = Math.min(canvas.width - x0, Math.ceil(rx * 2))
  const h = Math.min(canvas.height - y0, Math.ceil(ry * 2))
  if (w <= 0 || h <= 0) return undefined
  const data = ctx.getImageData(x0, y0, w, h).data
  let sum = 0
  let n = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (((x0 + x - cx) / rx) ** 2 + ((y0 + y - cy) / ry) ** 2 > 1) continue
      const i = (y * w + x) * 4
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3
      n++
    }
  return n ? sum / n : undefined
}
