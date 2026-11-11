/**
 * The open modal surfaces, top-most last, and where each one sits — so the
 * toast stack can stay off them (`app/Toast.tsx`). A toast never covers an
 * action: on a screen it floats above the action bar; over a modal it keeps
 * to the free space beside it, or goes beneath it where there is none (a
 * phone's sheet). A surface is registered by `useFocusTrap` while it traps
 * focus, which is what makes it modal.
 */

import { useEffect, useId, type RefObject } from 'react'
import { create } from 'zustand'

export interface Layer {
  id: string
  top: number
  bottom: number
  left: number
  right: number
  /** The surface's stacking level — beneath it is one lower. */
  z: number
}

interface LayersState {
  layers: Layer[]
  put: (layer: Layer) => void
  drop: (id: string) => void
}

export const useLayers = create<LayersState>()((set) => ({
  layers: [],
  put: (layer) =>
    set((s) => {
      const i = s.layers.findIndex((l) => l.id === layer.id)
      if (i === -1) return { layers: [...s.layers, layer] }
      const next = s.layers.slice()
      next[i] = layer
      return { layers: next }
    }),
  drop: (id) => set((s) => ({ layers: s.layers.filter((l) => l.id !== id) })),
}))

/** The nearest stacking level at or above the surface. */
function zOf(el: HTMLElement): number {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const z = Number(getComputedStyle(n).zIndex)
    if (Number.isFinite(z)) return z
  }
  return 0
}

/** Registers the surface while `active`, and keeps its place current as it settles, resizes or the window does. */
export function useModalLayer(ref: RefObject<HTMLElement | null>, active: boolean) {
  const id = useId()
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const { put, drop } = useLayers.getState()
    const measure = () => {
      const r = el.getBoundingClientRect()
      put({ id, top: r.top, bottom: r.bottom, left: r.left, right: r.right, z: zOf(el) })
    }
    measure()
    // Measured again once the entrance has settled, where the surface will stay.
    const settle = window.setTimeout(measure, 320)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(settle)
      ro.disconnect()
      window.removeEventListener('resize', measure)
      drop(id)
    }
  }, [ref, id, active])
}

/** Where the toast stack goes: its horizontal band and its stacking level. */
export interface ToastPlace {
  left: number
  right: number
  z: number
}

const STACK = 520
const MIN_FREE = 360
const EDGE = 16

/**
 * The stack's row is the bottom `height` px above `bottomGap`. Surfaces that
 * reach into that row take their width out of it; the stack centres in the
 * widest stretch left (nearest the middle), and goes beneath the surfaces when
 * no stretch is wide enough to read a toast in.
 */
export function placeToasts(layers: Layer[], height: number, vw: number, vh: number, bottomGap: number, above: number): ToastPlace {
  const rowTop = vh - bottomGap - height
  const rowBottom = vh - bottomGap
  const hits = layers.filter((l) => l.top < rowBottom && l.bottom > rowTop && l.right > EDGE && l.left < vw - EDGE)
  if (hits.length === 0) return { left: 0, right: 0, z: above }

  const taken = hits.map((l) => [Math.max(EDGE, l.left), Math.min(vw - EDGE, l.right)] as const).sort((a, b) => a[0] - b[0])
  const free: [number, number][] = []
  let from = EDGE
  for (const [a, b] of taken) {
    if (a > from) free.push([from, a])
    from = Math.max(from, b)
  }
  if (from < vw - EDGE) free.push([from, vw - EDGE])

  const middle = vw / 2
  const fits = free.filter(([a, b]) => b - a >= MIN_FREE).sort((x, y) => Math.abs((x[0] + x[1]) / 2 - middle) - Math.abs((y[0] + y[1]) / 2 - middle))
  if (fits.length > 0) {
    const [a, b] = fits[0]
    const width = Math.min(STACK, b - a)
    const left = (a + b) / 2 - width / 2
    return { left, right: vw - (left + width), z: above }
  }
  return { left: 0, right: 0, z: Math.min(...hits.map((l) => l.z)) - 1 }
}
