import { useEffect, useRef } from 'react'

// One stack for everything that sits above the page — dialogs and flow
// sheets. Only the TOP layer reacts to Escape, so a confirm dialog opened
// inside a flow closes on its own instead of taking the flow with it.

interface LayerEntry {
  onEscape: { current: (() => void) | undefined }
}

const stack: LayerEntry[] = []
let listening = false

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || stack.length === 0) return
  const top = stack[stack.length - 1]
  if (!top.onEscape.current) return
  event.preventDefault()
  event.stopPropagation()
  top.onEscape.current()
}

/** True while any dialog or flow sheet is open — global shortcuts pause. */
export function hasOpenLayer(): boolean {
  return stack.length > 0
}

/** Registers an open layer. `onEscape` always reads its latest value. */
export function useLayer(open: boolean, onEscape?: () => void): void {
  const handler = useRef(onEscape)
  useEffect(() => {
    handler.current = onEscape
  })

  useEffect(() => {
    if (!open) return undefined
    const entry: LayerEntry = { onEscape: handler }
    stack.push(entry)
    if (!listening) {
      document.addEventListener('keydown', handleKeyDown)
      listening = true
    }
    return () => {
      const index = stack.indexOf(entry)
      if (index !== -1) stack.splice(index, 1)
    }
  }, [open])
}
