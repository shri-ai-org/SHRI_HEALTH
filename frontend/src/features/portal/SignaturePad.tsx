import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

export interface SignaturePadHandle {
  clear: () => void
  isEmpty: () => boolean
  /** PNG data URL of the drawing. */
  toDataUrl: () => string
  /** Draws a saved signature back onto the pad (the old portal's "View"). */
  show: (dataUrl: string) => void
}

/**
 * The old portal's signature pad, with pointer events so a mouse, finger or pen all work. Ink uses
 * the current text colour so it reads in dark mode; the saved image is always dark ink on white.
 */
export const SignaturePad = forwardRef<SignaturePadHandle, { label: string; onChange?: (empty: boolean) => void }>(function SignaturePad({ label, onChange }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const strokes = useRef<Array<Array<[number, number]>>>([])
  const [empty, setEmpty] = useState(true)

  function ctx() {
    return canvas.current?.getContext('2d') ?? null
  }

  function redraw(color: string, background?: string) {
    const c = canvas.current
    const g = ctx()
    if (!c || !g) return
    g.clearRect(0, 0, c.width, c.height)
    if (background) {
      g.fillStyle = background
      g.fillRect(0, 0, c.width, c.height)
    }
    g.strokeStyle = color
    g.lineWidth = 2.5
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const s of strokes.current) {
      g.beginPath()
      s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
      g.stroke()
    }
  }

  function inkColor() {
    return canvas.current ? getComputedStyle(canvas.current).color : 'black'
  }

  function setIsEmpty(v: boolean) {
    setEmpty(v)
    onChange?.(v)
  }

  useEffect(() => {
    // Match the drawing buffer to the displayed size, so lines are sharp and land under the pointer.
    const c = canvas.current
    if (!c) return
    const ratio = window.devicePixelRatio || 1
    c.width = c.clientWidth * ratio
    c.height = c.clientHeight * ratio
    ctx()?.scale(ratio, ratio)
  }, [])

  function point(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const r = e.currentTarget.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  useImperativeHandle(ref, () => ({
    clear() {
      strokes.current = []
      redraw(inkColor())
      setIsEmpty(true)
    },
    isEmpty: () => strokes.current.length === 0,
    toDataUrl() {
      const c = canvas.current
      if (!c) return ''
      redraw('black', 'white')
      const url = c.toDataURL('image/png')
      redraw(inkColor())
      return url
    },
    show(dataUrl: string) {
      const c = canvas.current
      const g = ctx()
      if (!c || !g) return
      strokes.current = []
      const img = new Image()
      img.onload = () => {
        g.clearRect(0, 0, c.width, c.height)
        g.drawImage(img, 0, 0, c.clientWidth, c.clientHeight)
      }
      img.src = dataUrl
      setIsEmpty(true)
    },
  }))

  return (
    <div>
      <div role="img" aria-label={`${label}. ${empty ? 'Empty.' : 'Signed.'} Draw with a mouse, finger or pen.`}>
      <canvas
        ref={canvas}
        className="h-48 w-full touch-none rounded-lg border-2 border-dashed border-border-strong bg-surface-1 text-ink sm:h-56"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drawing.current = true
          strokes.current.push([point(e)])
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return
          strokes.current[strokes.current.length - 1]?.push(point(e))
          redraw(inkColor())
        }}
        onPointerUp={() => {
          drawing.current = false
          if (strokes.current.length && empty) setIsEmpty(false)
        }}
      />
      </div>
      <p className="mt-1 text-xs text-ink-subtle">Sign inside the box. If you can't draw, call the clinic to sign in person.</p>
    </div>
  )
})
